/**
 * P1.5：改稿与级联修订。
 *
 * - diff 只做到行（网文通常一行一段）级，避免字符级噪音；
 * - 影响分析只提示“后续哪些章可能受影响”，不改正文；
 * - 级联检查复用现有确定性连贯性检查器；
 * - 修订任务按设计落在 content/revisions/<novelId>/tasks.json。
 */
import type { Chapter, Volume } from '@shared/types'
import type {
  CascadeChapterResult,
  CascadeFinding,
  CascadeReport,
  DiffResult,
  DiffSegment,
  ImpactEntity,
  ImpactHit,
  ImpactReport,
  RevisionTask,
  RevisionTaskInput,
  RevisionTaskStatus,
  RevisionTaskType,
} from '@shared/revision-types'
import { chapterService, characterService, volumeService } from './data-service'
import { latestCharacterStates, listCharacterStates } from './story-state-service'
import { checkChapterContinuity } from './story-check-service'

const api = () => window.electronAPI

// ===== Diff =====

// 行数乘积上限：超过后退化为“公共前后缀 + 中间整块替换”，避免大章节卡住主线程。
const MAX_DIFF_CELLS = 4_000_000
const MAX_TASK_DESCRIPTION = 500

type DiffOp = { kind: 'equal' | 'added' | 'removed'; line: string }

function lcsOps(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length
  const m = newLines.length
  if (n * m > MAX_DIFF_CELLS) return coarseOps(oldLines, newLines)

  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * width + j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[(i - 1) * width + (j - 1)] + 1
        : Math.max(dp[(i - 1) * width + j], dp[i * width + (j - 1)])
    }
  }

  const ops: DiffOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ kind: 'equal', line: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i * width + (j - 1)] >= dp[(i - 1) * width + j])) {
      ops.push({ kind: 'added', line: newLines[j - 1] })
      j--
    } else {
      ops.push({ kind: 'removed', line: oldLines[i - 1] })
      i--
    }
  }
  return ops.reverse()
}

function coarseOps(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const ops: DiffOp[] = []
  for (let i = 0; i < prefix; i++) ops.push({ kind: 'equal', line: oldLines[i] })
  for (let i = prefix; i < oldLines.length - suffix; i++) ops.push({ kind: 'removed', line: oldLines[i] })
  for (let i = prefix; i < newLines.length - suffix; i++) ops.push({ kind: 'added', line: newLines[i] })
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) ops.push({ kind: 'equal', line: oldLines[i] })
  return ops
}

/** 段/行级 diff：old = 快照，new = 当前正文。 */
export function computeDiff(oldText: string, newText: string): DiffResult {
  const ops = lcsOps(oldText.split('\n'), newText.split('\n'))
  const segments: DiffSegment[] = []
  let oldPos = 1
  let newPos = 1
  let index = 0

  for (const op of ops) {
    const last = segments[segments.length - 1]
    if (last && last.kind === op.kind) {
      last.lines.push(op.line)
    } else {
      segments.push({
        key: `${op.kind}-${index++}`,
        kind: op.kind,
        lines: [op.line],
        oldStart: oldPos,
        newStart: newPos,
      })
    }
    if (op.kind !== 'added') oldPos++
    if (op.kind !== 'removed') newPos++
  }

  const count = (kind: DiffSegment['kind']) =>
    segments.filter((s) => s.kind === kind).reduce((sum, s) => sum + s.lines.length, 0)

  return {
    segments,
    summary: {
      added: count('added'),
      removed: count('removed'),
      unchanged: count('equal'),
    },
  }
}

/**
 * 合并采用/撤回后的正文。
 * accepted[key] = true 表示“采用当前版本”：保留新增行、删除删除行；
 * false 表示“撤回该段”：丢弃新增行、恢复快照中的删除行。
 * 未出现在 accepted 中的改动段默认采用。
 */
export function applyDiff(segments: DiffSegment[], accepted: Record<string, boolean>): string {
  const out: string[] = []
  for (const seg of segments) {
    if (seg.kind === 'equal') {
      out.push(...seg.lines)
      continue
    }
    const adopt = accepted[seg.key] ?? true
    if (seg.kind === 'added') {
      if (adopt) out.push(...seg.lines)
    } else if (!adopt) {
      out.push(...seg.lines)
    }
  }
  return out.join('\n')
}

/** 改动段文本，用于从 diff 中提取受影响实体。 */
export function changedText(segments: DiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== 'equal')
    .flatMap((s) => s.lines)
    .join('\n')
}

export function countChanges(segments: DiffSegment[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const seg of segments) {
    if (seg.kind === 'added') added += seg.lines.length
    if (seg.kind === 'removed') removed += seg.lines.length
  }
  return { added, removed }
}

// ===== 影响分析 =====

export interface NovelChapterRef {
  chapter: Chapter
  volume: Volume
  /** 全书顺序（卷序 + 章序），用于只分析源章之后的章节。 */
  order: number
}

/** 全书章节按卷序、章序拉平。 */
export async function listNovelChapters(novelId: string): Promise<NovelChapterRef[]> {
  const volumes = (await volumeService.getByNovelId(novelId)).sort((a, b) => a.order - b.order)
  const refs: NovelChapterRef[] = []
  for (const volume of volumes) {
    const chapters = (await chapterService.getByVolumeId(volume.id)).sort((a, b) => a.order - b.order)
    for (const chapter of chapters) {
      refs.push({ chapter, volume, order: refs.length + 1 })
    }
  }
  return refs
}

/** 已知实体：角色名优先，其次当前状态里的物品与能力。 */
export async function collectKnownEntities(novelId: string): Promise<ImpactEntity[]> {
  const [characters, states] = await Promise.all([
    characterService.getByNovelId(novelId),
    listCharacterStates(novelId).catch(() => []),
  ])
  const entities = new Map<string, ImpactEntity>()
  for (const c of characters) {
    const name = (c.name ?? '').trim()
    if (name.length >= 2) entities.set(name, { name, kind: 'character' })
  }
  for (const state of latestCharacterStates(states)) {
    for (const item of state.items) {
      const name = (item.name ?? '').trim()
      if (name.length >= 2 && !entities.has(name)) entities.set(name, { name, kind: 'item' })
    }
    for (const ability of state.abilities) {
      const name = (ability.name ?? '').trim()
      if (name.length >= 2 && !entities.has(name)) entities.set(name, { name, kind: 'ability' })
    }
  }
  return Array.from(entities.values())
}

/** 只保留在改动段中出现过的已知实体；同名实体去重并优先保留角色。 */
export function extractChangedEntities(
  segments: DiffSegment[],
  known: ImpactEntity[],
  limit = 12
): ImpactEntity[] {
  const text = changedText(segments)
  if (!text.trim()) return []
  const found: ImpactEntity[] = []
  const seen = new Set<string>()
  for (const entity of known) {
    if (entity.name.length < 2 || seen.has(entity.name)) continue
    if (!text.includes(entity.name)) continue
    seen.add(entity.name)
    found.push(entity)
    if (found.length >= limit) break
  }
  return found.sort((a, b) => b.name.length - a.name.length)
}

function sentenceAround(content: string, index: number, length: number): string {
  const boundary = /[\n。！？；]/
  let start = index
  while (start > 0 && !boundary.test(content[start - 1])) start--
  let end = index + length
  while (end < content.length && !boundary.test(content[end])) end++
  if (end < content.length) end++
  const sentence = content.slice(start, end).replace(/\s+/g, ' ').trim()
  return sentence.length > 90 ? `${sentence.slice(0, 90)}…` : sentence
}

/**
 * 在源章之后的章节里检索实体。命中只作提示，不判定必须修改。
 * 关键词由调用方补充（如作者手动输入的角色别名）。
 */
export async function analyzeImpact(params: {
  novelId: string
  sourceChapterId: string
  entities: ImpactEntity[]
  maxChapters?: number
}): Promise<ImpactReport> {
  const entities = params.entities
    .map((e) => ({ ...e, name: e.name.trim() }))
    .filter((e) => e.name.length >= 2)
  const refs = await listNovelChapters(params.novelId)
  const sourceIndex = refs.findIndex((r) => r.chapter.id === params.sourceChapterId)
  const subsequent = sourceIndex >= 0 ? refs.slice(sourceIndex + 1) : refs
  const limit = Math.min(subsequent.length, params.maxChapters ?? 100)
  const hits: ImpactHit[] = []
  let scanned = 0

  for (const ref of subsequent.slice(0, limit)) {
    if (!entities.length) break
    let content = ''
    try {
      content = await chapterService.loadContent(ref.chapter.id)
    } catch {
      continue
    }
    if (!content) continue
    scanned++
    for (const entity of entities) {
      const idx = content.indexOf(entity.name)
      if (idx < 0) continue
      hits.push({
        chapterId: ref.chapter.id,
        chapterTitle: ref.chapter.title,
        chapterOrder: ref.order,
        volumeId: ref.volume.id,
        volumeTitle: ref.volume.title,
        entity: entity.name,
        reason: `后续章节仍提及「${entity.name}」`,
        sentence: sentenceAround(content, idx, entity.name.length),
      })
    }
  }

  return { entities, hits, scannedChapters: scanned }
}

// ===== 级联检查 =====

const CASCADE_CHAPTER_LIMIT = 20

/** 对受影响章跑确定性连贯性规则；只出报告，不改正文。 */
export async function runCascadeCheck(params: {
  novelId: string
  chapterIds: string[]
}): Promise<CascadeReport> {
  const wanted = new Set(params.chapterIds)
  if (!wanted.size) return { chapters: [], scannedChapters: 0, blocking: 0, warnings: 0 }

  const refs = await listNovelChapters(params.novelId)
  const targets = refs.filter((r) => wanted.has(r.chapter.id)).slice(0, CASCADE_CHAPTER_LIMIT)
  const chapters: CascadeChapterResult[] = []

  for (const ref of targets) {
    const content = await chapterService.loadContent(ref.chapter.id)
    if (!content) continue
    const findings = await checkChapterContinuity({
      novelId: params.novelId,
      chapterId: ref.chapter.id,
      chapterOrder: ref.chapter.order,
      hooks: ref.chapter.hooks,
      content,
    })
    chapters.push({
      chapterId: ref.chapter.id,
      chapterTitle: ref.chapter.title,
      chapterOrder: ref.order,
      findings: findings as CascadeFinding[],
    })
  }

  return {
    chapters,
    scannedChapters: targets.length,
    blocking: chapters.reduce(
      (sum, c) => sum + c.findings.filter((f) => f.severity === 'blocking').length,
      0
    ),
    warnings: chapters.reduce(
      (sum, c) => sum + c.findings.filter((f) => f.severity === 'warning').length,
      0
    ),
  }
}

// ===== 修订任务 =====

const TASK_TYPES: RevisionTaskType[] = ['continuity', 'outline', 'polish', 'rewrite']
const TASK_STATUSES: RevisionTaskStatus[] = ['open', 'done', 'ignored']

function tasksPath(novelId: string): string {
  return `content/revisions/${novelId}/tasks.json`
}

function sanitizeTask(raw: any): RevisionTask | null {
  if (!raw || typeof raw !== 'object') return null
  const target = typeof raw.targetChapterId === 'string' ? raw.targetChapterId : ''
  if (!target) return null
  const type = TASK_TYPES.includes(raw.type) ? raw.type : 'continuity'
  const status = TASK_STATUSES.includes(raw.status) ? raw.status : 'open'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `rev_${Math.random().toString(36).slice(2, 10)}`,
    sourceChapterId: typeof raw.sourceChapterId === 'string' ? raw.sourceChapterId : '',
    targetChapterId: target,
    type,
    description: typeof raw.description === 'string' ? raw.description : '',
    status,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    resolvedAt: typeof raw.resolvedAt === 'string' ? raw.resolvedAt : undefined,
  }
}

export async function loadRevisionTasks(novelId: string): Promise<RevisionTask[]> {
  try {
    const raw = await api().file.read(tasksPath(novelId))
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : []
    return list.map(sanitizeTask).filter((t: RevisionTask | null): t is RevisionTask => !!t)
  } catch {
    return [] // 文件不存在或内容损坏 = 还没有任务
  }
}

export async function saveRevisionTasks(novelId: string, tasks: RevisionTask[]): Promise<void> {
  await api().file.write(tasksPath(novelId), JSON.stringify(tasks, null, 2))
}

export async function addRevisionTask(input: RevisionTaskInput): Promise<RevisionTask> {
  const description = input.description.trim().slice(0, MAX_TASK_DESCRIPTION)
  const task: RevisionTask = {
    id: `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    sourceChapterId: input.sourceChapterId,
    targetChapterId: input.targetChapterId,
    type: input.type,
    description,
    status: 'open',
    createdAt: new Date().toISOString(),
  }
  const tasks = await loadRevisionTasks(input.novelId)
  await saveRevisionTasks(input.novelId, [...tasks, task])
  return task
}

export async function updateRevisionTaskStatus(
  novelId: string,
  taskId: string,
  status: RevisionTaskStatus
): Promise<RevisionTask[]> {
  const tasks = await loadRevisionTasks(novelId)
  const next = tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status,
          resolvedAt: status === 'open' ? undefined : new Date().toISOString(),
        }
      : task
  )
  await saveRevisionTasks(novelId, next)
  return next
}

export async function deleteRevisionTask(novelId: string, taskId: string): Promise<RevisionTask[]> {
  const tasks = (await loadRevisionTasks(novelId)).filter((task) => task.id !== taskId)
  await saveRevisionTasks(novelId, tasks)
  return tasks
}
