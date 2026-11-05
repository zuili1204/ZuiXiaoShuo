/**
 * 追踪服务（Tracking Service）
 *
 * P2：状态卡 + 检查点落盘 + 断点续跑。
 * P6：检查点 / 角色资源账本改用 SQLite 作为权威持久化（取代原 JSON 文件方案），
 *     支持事务回写、按 novel_id / task_id 索引查询与回放。
 *
 * 对外导出签名（loadCheckpoints / saveCheckpoint / loadResumePoint /
 * loadLedger / saveLedgerEntry / commitChapter / generateStateCard）保持不变，
 * 调用方零改动。
 */

import type { AgentRole, Checkpoint, QualityGate } from '@shared/types'
import { AGENT_ROLE_LABELS } from '@shared/constants'
import { chapterService, volumeService, foreshadowingService } from './data-service'
import { indexChapterSummary } from './rag-service'
import type { Chapter, Volume } from '@shared/types'

const api = () => window.electronAPI

/** 将追踪状态落盘到 content/tracking/<novelId>.json（修复 G5：此前从未落盘，注入永远为空）。 */
async function saveTrackingStateFile(novelId: string, state: TrackingState): Promise<void> {
  try {
    const path = `content/tracking/${novelId}.json`
    await window.electronAPI.file.write(path, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error('[tracking] saveTrackingStateFile failed:', e)
  }
}

// ===== 行 <-> 领域对象 映射 =====

function rowToCheckpoint(row: any): Checkpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    novelId: row.novel_id,
    stageIndex: row.stage_index,
    agentRole: row.agent_role as AgentRole,
    intent: row.intent ?? undefined,
    input: row.input ?? undefined,
    output: row.output ?? '',
    quality: row.quality_json ? safeParse(row.quality_json) : null,
    status: row.status as Checkpoint['status'],
    createdAt: row.created_at,
  }
}

function rowToLedger(row: any): RoleLedgerEntry {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterTitle: row.chapter_title ?? undefined,
    chain: safeParse(row.chain_json) ?? [],
    updatedAt: row.updated_at,
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s) } catch { return null }
}

// ===== 检查点（director_checkpoints） =====

/** 读取某小说全部检查点（按阶段顺序、创建时间升序）。 */
export async function loadCheckpoints(novelId: string): Promise<Checkpoint[]> {
  try {
    const rows = await api().db.query(
      'SELECT * FROM director_checkpoints WHERE novel_id = ? ORDER BY stage_index ASC, created_at ASC',
      [novelId]
    ) as any[]
    return rows.map(rowToCheckpoint)
  } catch (e) {
    console.error('[tracking] loadCheckpoints failed:', e)
    return []
  }
}

/** 写入（upsert）单个检查点，返回最新检查点列表。 */
export async function saveCheckpoint(novelId: string, cp: Checkpoint): Promise<Checkpoint[]> {
  try {
    await api().db.query(
      `INSERT INTO director_checkpoints (id, task_id, novel_id, stage_index, agent_role, intent, input, output, quality_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id=excluded.task_id,
         novel_id=excluded.novel_id,
         stage_index=excluded.stage_index,
         agent_role=excluded.agent_role,
         intent=excluded.intent,
         input=excluded.input,
         output=excluded.output,
         quality_json=excluded.quality_json,
         status=excluded.status,
         created_at=excluded.created_at`,
      [
        cp.id,
        cp.taskId,
        novelId,
        cp.stageIndex,
        cp.agentRole,
        cp.intent ?? null,
        cp.input ?? null,
        cp.output ?? '',
        cp.quality ? JSON.stringify(cp.quality) : null,
        cp.status,
        cp.createdAt || new Date().toISOString(),
      ]
    )
  } catch (e) {
    console.error('[tracking] saveCheckpoint failed:', e)
  }
  return loadCheckpoints(novelId)
}

/**
 * 读取续跑点：状态为 pending / awaiting-approval 的检查点（按阶段顺序）。
 * 用于崩溃 / 断网后从最近断点恢复。
 */
export async function loadResumePoint(novelId: string): Promise<Checkpoint[]> {
  try {
    const rows = await api().db.query(
      `SELECT * FROM director_checkpoints
       WHERE novel_id = ? AND status IN ('pending', 'awaiting-approval')
       ORDER BY stage_index ASC, created_at ASC`,
      [novelId]
    ) as any[]
    return rows.map(rowToCheckpoint)
  } catch (e) {
    console.error('[tracking] loadResumePoint failed:', e)
    return []
  }
}

// ===== 角色资源账本（role_ledger） =====

export interface LedgerChainNode {
  agentRole: AgentRole
  action: 'generate' | 'review' | 'fix' | 'inject'
  status: 'pending' | 'done' | 'failed'
  output?: string
  note?: string
}

export interface RoleLedgerEntry {
  id: string
  novelId: string
  chapterTitle?: string
  chain: LedgerChainNode[]
  updatedAt: string
}

/** 读取某小说角色资源账本（按更新时间倒序，最近 20 条）。 */
export async function loadLedger(novelId: string): Promise<RoleLedgerEntry[]> {
  try {
    const rows = await api().db.query(
      'SELECT * FROM role_ledger WHERE novel_id = ? ORDER BY updated_at DESC LIMIT 20',
      [novelId]
    ) as any[]
    return rows.map(rowToLedger)
  } catch (e) {
    console.error('[tracking] loadLedger failed:', e)
    return []
  }
}

/** 写入（upsert）单条账本记录，返回最新账本列表。 */
export async function saveLedgerEntry(entry: RoleLedgerEntry): Promise<RoleLedgerEntry[]> {
  try {
    await api().db.query(
      `INSERT INTO role_ledger (id, novel_id, chapter_title, chain_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         novel_id=excluded.novel_id,
         chapter_title=excluded.chapter_title,
         chain_json=excluded.chain_json,
         updated_at=excluded.updated_at`,
      [
        entry.id,
        entry.novelId,
        entry.chapterTitle ?? null,
        JSON.stringify(entry.chain ?? []),
        entry.updatedAt || new Date().toISOString(),
      ]
    )
  } catch (e) {
    console.error('[tracking] saveLedgerEntry failed:', e)
  }
  return loadLedger(entry.novelId)
}

/** 章节执行完成：提交一次账本记录（生成→审核→修复→回灌链路）。 */
export async function commitLedgerEntry(
  novelId: string,
  chapterTitle: string,
  quality: QualityGate | null,
  fixReport?: string
): Promise<RoleLedgerEntry> {
  const passed = quality?.passed ?? true
  const entry: RoleLedgerEntry = {
    id: `ledger-${novelId}-${Date.now()}`,
    novelId,
    chapterTitle,
    chain: [
      { agentRole: 'writer', action: 'generate', status: 'done', output: chapterTitle },
      { agentRole: 'checker', action: 'review', status: passed ? 'done' : 'failed', note: passed ? '质量门禁通过' : `门禁未过：${quality?.report ?? `综合分 ${quality?.score ?? 0}`}` },
      ...(passed ? [] : [{ agentRole: 'polisher', action: 'fix', status: 'done', note: fixReport ?? '已修复' } as LedgerChainNode]),
      { agentRole: 'runtime', action: 'inject', status: 'done', note: '状态已回灌追踪层' },
    ],
    updatedAt: new Date().toISOString(),
  }
  await saveLedgerEntry(entry)
  return entry
}

// ===== 单章提交（落盘摘要 + 伏笔 + 状态卡） =====

export interface CommitChapterInput {
  chapterId: string
  chapterTitle: string
  summary: string
  wordCount: number
  keyEvents: string[]
  charactersInvolved: string[]
  newForeshadowings: string[]
  resolvedForeshadowings: string[]
  plotQuestions: string[]
  /** 状态事务来源：手工编辑 / AI 工具 / 流水线 */
  source?: TrackingSource
  /**
   * IMP-03：本章正文全文。
   * - 提供：先落盘 md（chapterService.saveContent）再更新元信息；
   * - 不提供：校验磁盘 md 已有内容；为空则抛错，避免把「没有正文的章节」标成 final。
   */
  content?: string
}

export interface CommitChapterResult {
  committedChapters: Chapter[]
}

/** 读取某小说全部章节（按卷序 + 章节序）。 */
async function loadNovelChapters(novelId: string): Promise<Chapter[]> {
  const volumes = (await volumeService.getByNovelId(novelId)) as Volume[]
  const list: Chapter[] = []
  for (const v of volumes) {
    const chs = (await chapterService.getByVolumeId(v.id)) as Chapter[]
    list.push(...chs)
  }
  return list
}

/**
 * IMP-03：确保章节正文真正落到磁盘。
 *
 * - 传入 content：写入 md（saveContent 会同步刷新 word_count）；
 * - 未传 content：校验磁盘 md 已有内容——为空则抛错，
 *   避免把"没有正文的章节"静默标记为 final（这正是历史数据损坏的成因）。
 *
 * 抛错后由调用方决定：工具层转成 {ok:false} 引导模型先写正文，UI 层提示用户。
 */
/**
 * 正文为空的提交错误：必须让调用方感知。
 * 与内部错误区分——内部错误仍按原策略降级返回，空正文则向上抛，
 * 否则调用方会拿到 {committedChapters: []} 却以为提交成功。
 */
export class EmptyChapterContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyChapterContentError'
  }
}

async function persistChapterContent(novelId: string, input: CommitChapterInput): Promise<void> {
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim()) {
    await chapterService.saveContent(input.chapterId, content, {
      source: input.source ?? 'manual',
      novelId,
    })
    return
  }

  let existing = ''
  try {
    existing = await chapterService.loadContent(input.chapterId)
  } catch {
    existing = ''
  }
  if (!existing.trim()) {
    throw new EmptyChapterContentError(
      `章节「${input.chapterTitle}」正文为空，无法标记为已完成。请先写入正文（在编辑器保存，或让 commit_tracking 带上 content 参数）。`
    )
  }
}

/**
 * 完成一章：落盘本章摘要/字数/状态，写入新伏笔、回收已解伏笔，
 * 并追加一条角色资源账本记录。返回本书已收录章节列表。
 */
export async function commitChapterAndSave(
  novelId: string,
  input: CommitChapterInput
): Promise<CommitChapterResult> {
  try {
    const chapter = await chapterService.getById(input.chapterId)
    const plantedChapter = chapter?.order ?? 0

    // IMP-03：先确保正文落盘。
    // 历史 bug：这里只 UPDATE 数据库（summary/word_count/status='final'），从不写 md，
    // 结果"数据库显示已完成、磁盘文件却是 0 字节或根本不存在"。
    await persistChapterContent(novelId, input)

    // 1. 落盘本章摘要、字数与状态
    await api().db.query(
      `UPDATE chapters SET summary = ?, word_count = ?, status = 'final', updated_at = ? WHERE id = ?`,
      [input.summary, input.wordCount, new Date().toISOString(), input.chapterId]
    )

    // 2. 新伏笔入库（D-T5-2：同书同内容幂等去重——重复「完成本章」/重复 commit 不再产生重复伏笔）
    const existingFsRows = (await api().db.query(
      'SELECT content FROM foreshadowings WHERE novel_id = ?',
      [novelId]
    )) as any[]
    const existingFsContents = new Set<string>(existingFsRows.map((r) => r.content))
    for (const content of input.newForeshadowings) {
      if (existingFsContents.has(content)) continue
      existingFsContents.add(content)
      await foreshadowingService.create({
        id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        novelId,
        content,
        plantedChapter,
        status: 'planted',
        importance: 'minor',
      })
    }

    // 3. 已回收伏笔标记为 resolved
    if (input.resolvedForeshadowings.length) {
      const rows = (await api().db.query('SELECT * FROM foreshadowings WHERE novel_id = ?', [novelId])) as any[]
      for (const r of rows) {
        if (input.resolvedForeshadowings.includes(r.content)) {
          await foreshadowingService.updateStatus(r.id, 'resolved', r.planted_chapter)
        }
      }
    }

    // 4. 写入角色资源账本
    await commitLedgerEntry(novelId, input.chapterTitle, null)

    // 5. 同步创作追踪状态卡（落盘，供上下文注入读取）
    const prevState = await loadTrackingState(novelId)
    const nextState = commitChapter(prevState, input)
    const record: StateTransactionRecord = {
      transactionId: `stx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expectedRevision: prevState.revision,
      revision: nextState.revision,
      source: input.source ?? 'ai',
      committedAt: new Date().toISOString(),
      retiredItems: [],
      changed: ['chapter'],
    }
    await saveTrackingStateFile(novelId, {
      ...nextState,
      transactions: [...(nextState.transactions ?? []), record].slice(-50),
    })

    // 6. 把本章摘要灌入 RAG，提升跨章召回
    try {
      const chapter = await chapterService.getById(input.chapterId)
      if (chapter) indexChapterSummary(novelId, chapter.id, input.chapterTitle, input.summary, chapter.order)
    } catch (e) {
      console.error('[tracking] reindex chapter summary failed:', e)
    }

    // 7. 返回本书已收录章节
    return { committedChapters: await loadNovelChapters(novelId) }
  } catch (e) {
    console.error('[tracking] commitChapterAndSave failed:', e)
    // IMP-03：空正文是明确的调用方错误，必须向上抛，否则会被静默降级成"成功"
    if (e instanceof EmptyChapterContentError) throw e
    return { committedChapters: [] }
  }
}

// ===== 创作追踪状态（内存态，落盘到 content/tracking/<novelId>.json） =====

export interface ForeshadowingState {
  id: string
  content: string
  plantedChapter: number
  status: 'planted' | 'resolved'
  importance: 'minor' | 'major'
}

export interface CommittedChapter {
  id: string
  title: string
  summary: string
  wordCount: number
  keyEvents: string[]
  charactersInvolved: string[]
  status: 'final'
}

export interface RecentChapter {
  chapter: number
  title: string
  summary: string
  keyEvents: string[]
}

export interface TimelineEntry {
  chapter: number
  event: string
}

export type TrackingSource = 'manual' | 'ai' | 'pipeline'

export interface RetiredItem {
  kind: 'constraint' | 'risk' | 'promise'
  content: string
}

export interface StateTransactionRecord {
  transactionId: string
  expectedRevision: number
  revision: number
  source: TrackingSource
  committedAt: string
  retiredItems: RetiredItem[]
  changed: string[]
}

export interface TrackingStatePatch {
  currentPosition?: { volume: number; chapter: number }
  longTermConstraints?: string[]
  coherenceRisks?: string[]
  nextChapterPromises?: string[]
  retiredItems?: RetiredItem[]
}

export type StateCommitResult =
  | { ok: true; state: TrackingState }
  | { ok: false; conflict: true; currentRevision: number; state: TrackingState }

export interface TrackingState {
  novelId: string
  revision: number
  currentPosition: { volume: number; chapter: number }
  committedChapters: CommittedChapter[]
  totalWordCount: number
  activeForeshadowings: ForeshadowingState[]
  characterInvolvements: Record<string, string[]>
  longTermConstraints: string[]
  coherenceRisks: string[]
  nextChapterPromises: string[]
  recentChapters: RecentChapter[]
  timelineAuthor: TimelineEntry[]
  pendingApprovals: number
  characters: number
  foreshadowings: number
  lastUpdate: string | null
  /** 状态事务日志（append-only，最多 50 条，只记元信息不记正文） */
  transactions?: StateTransactionRecord[]
}

/** 构造空追踪状态（含 UI/agent 所需的全部字段）。 */
export function createDefaultState(novelId: string): TrackingState {
  return {
    novelId,
    revision: 1,
    currentPosition: { volume: 1, chapter: 0 },
    committedChapters: [],
    totalWordCount: 0,
    activeForeshadowings: [],
    characterInvolvements: {},
    longTermConstraints: [],
    coherenceRisks: [],
    nextChapterPromises: [],
    recentChapters: [],
    timelineAuthor: [],
    pendingApprovals: 0,
    characters: 0,
    foreshadowings: 0,
    lastUpdate: null,
    transactions: [],
  }
}

/** 内存态提交单章：累计字数、记录/回收伏笔、更新最近章节与角色参与。 */
export function commitChapter(state: TrackingState, input: CommitChapterInput): TrackingState {
  const existingIdx = state.committedChapters.findIndex((c) => c.id === input.chapterId)
  const chapter: CommittedChapter = {
    id: input.chapterId,
    title: input.chapterTitle,
    summary: input.summary,
    wordCount: input.wordCount,
    keyEvents: input.keyEvents,
    charactersInvolved: input.charactersInvolved,
    status: 'final',
  }
  const committedChapters = [...state.committedChapters]
  if (existingIdx >= 0) committedChapters[existingIdx] = chapter
  else committedChapters.push(chapter)

  const totalWordCount = committedChapters.reduce((s, c) => s + (c.wordCount || 0), 0)
  const plantedChapter = committedChapters.length

  // 新伏笔入库（内存态；D-T5-2：同内容幂等去重，重复 commit 不产生重复伏笔）
  const activeForeshadowings = [...state.activeForeshadowings]
  for (const content of input.newForeshadowings) {
    if (activeForeshadowings.some((f) => f.content === content)) continue
    activeForeshadowings.push({
      id: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      plantedChapter,
      status: 'planted',
      importance: 'minor',
    })
  }
  // 回收已解伏笔
  for (const content of input.resolvedForeshadowings) {
    const fs = activeForeshadowings.find((f) => f.status === 'planted' && f.content === content)
    if (fs) fs.status = 'resolved'
  }

  // 角色参与（D-T5-2：同章重复 commit 不重复累计出场章节）
  const characterInvolvements = { ...state.characterInvolvements }
  for (const name of input.charactersInvolved) {
    const titles = characterInvolvements[name] ?? []
    if (titles.includes(input.chapterTitle)) continue
    characterInvolvements[name] = [...titles, input.chapterTitle]
  }

  // 最近三章速记
  const recentChapters = [...state.recentChapters]
  const recentIdx = recentChapters.findIndex((r) => r.chapter === plantedChapter && r.title === input.chapterTitle)
  const recentEntry: RecentChapter = {
    chapter: plantedChapter,
    title: input.chapterTitle,
    summary: input.summary,
    keyEvents: input.keyEvents,
  }
  if (recentIdx >= 0) recentChapters[recentIdx] = recentEntry
  else recentChapters.push(recentEntry)

  return {
    ...state,
    revision: state.revision + 1,
    currentPosition: { ...state.currentPosition, chapter: committedChapters.length },
    committedChapters,
    totalWordCount,
    activeForeshadowings,
    characterInvolvements,
    recentChapters: recentChapters.slice(-3),
    foreshadowings: activeForeshadowings.filter((f) => f.status === 'planted').length,
    lastUpdate: new Date().toISOString(),
  }
}

/** 生成续写状态卡（纯文本，供 UI 概览）。 */
export function generateStateCard(state: TrackingState, novelTitle?: string): string {
  const active = state.activeForeshadowings.filter((f) => f.status === 'planted')
  const resolved = state.activeForeshadowings.filter((f) => f.status === 'resolved')
  const lines = [
    // D-T5-1：优先显示书名，未提供时回退 novelId
    `小说: ${novelTitle || state.novelId}`,
    `进度: 第 ${state.currentPosition.volume} 卷 · 第 ${state.currentPosition.chapter} 章`,
    `已收录章节: ${state.committedChapters.length} 章`,
    `总字数: ${state.totalWordCount}`,
    `伏笔: ${active.length} 活跃 / ${resolved.length} 已回收`,
    `长期约束: ${state.longTermConstraints.length} 条`,
    `连贯性风险: ${state.coherenceRisks.length} 条`,
  ]
  if (state.longTermConstraints.length) lines.push('', '【长期约束】', ...state.longTermConstraints.map((c) => `  - ${c}`))
  if (state.coherenceRisks.length) lines.push('', '【连贯性风险】', ...state.coherenceRisks.map((c) => `  - ${c}`))
  if (state.nextChapterPromises.length) lines.push('', '【下一章承诺】', ...state.nextChapterPromises.map((c) => `  - ${c}`))
  return lines.join('\n')
}

/** 角色状态快照：角色 -> 参与章节列表文本（供 UI）。 */
export function generateCharacterSnapshots(state: TrackingState): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, chapters] of Object.entries(state.characterInvolvements)) {
    out[name] = `角色「${name}」\n近期出场章节: ${chapters.length} 章\n${chapters.map((c) => `  - ${c}`).join('\n')}`
  }
  return out
}

/** 伏笔视图：活跃伏笔 + 连贯性风险 + 长期约束（供 agent 上下文）。 */
export function generateForeshadowView(state: TrackingState): string {
  const active = state.activeForeshadowings.filter((f) => f.status === 'planted')
  const lines: string[] = []
  if (active.length) {
    lines.push('活跃伏笔（待回收）:')
    for (const f of active) lines.push(`  - [第${f.plantedChapter}章埋设] ${f.content}`)
  }
  if (state.coherenceRisks.length) {
    lines.push('', '连贯性风险:')
    for (const r of state.coherenceRisks) lines.push(`  - ${r}`)
  }
  if (state.longTermConstraints.length) {
    lines.push('', '长期约束:')
    for (const c of state.longTermConstraints) lines.push(`  - ${c}`)
  }
  return lines.join('\n')
}

/** 读取并解析追踪状态（落盘文件 content/tracking/<novelId>.json）。 */
export async function loadTrackingState(novelId: string): Promise<TrackingState> {
  try {
    const path = `content/tracking/${novelId}.json`
    const exists = await window.electronAPI?.file?.exists?.(path)
    if (exists) {
      const raw = await window.electronAPI!.file!.read(path)
      const parsed = JSON.parse(raw)
      return { ...createDefaultState(novelId), ...parsed, novelId }
    }
  } catch (e) {
    console.error('[tracking] loadTrackingState failed:', e)
  }
  return createDefaultState(novelId)
}

// ===== 状态事务（expectedRevision + retiredItems + 原子写） =====

// 同一本书的读-改-写串行化；跨窗口并发由 revision 校验兜底
const stateWriteQueues = new Map<string, Promise<unknown>>()

function enqueueStateWrite<T>(novelId: string, task: () => Promise<T>): Promise<T> {
  const prev = stateWriteQueues.get(novelId) ?? Promise.resolve()
  const run = prev.then(task, task)
  stateWriteQueues.set(novelId, run.catch(() => {}))
  return run
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map((s) => s.trim()).filter(Boolean)))
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * 提交状态事务：
 * - revision 与 expectedRevision 不一致 → 拒绝写入并返回当前状态（冲突可见）；
 * - retiredItems 从对应栏目移除；
 * - 成功写盘后 revision + 1，并追加一条事务日志。
 */
export async function commitTrackingState(
  novelId: string,
  patch: TrackingStatePatch,
  opts: { expectedRevision: number; source: TrackingSource; transactionId?: string },
): Promise<StateCommitResult> {
  return enqueueStateWrite(novelId, async () => {
    const current = await loadTrackingState(novelId)
    if (current.revision !== opts.expectedRevision) {
      return { ok: false, conflict: true, currentRevision: current.revision, state: current }
    }

    const retired = patch.retiredItems ?? []
    const retire = (items: string[], kind: RetiredItem['kind']) =>
      items.filter((item) => !retired.some((r) => r.kind === kind && r.content === item))

    const longTermConstraints = retire(
      unique(patch.longTermConstraints ?? current.longTermConstraints),
      'constraint',
    ).slice(0, 6)
    const coherenceRisks = retire(unique(patch.coherenceRisks ?? current.coherenceRisks), 'risk')
    const nextChapterPromises = retire(
      unique(patch.nextChapterPromises ?? current.nextChapterPromises),
      'promise',
    )
    const currentPosition = patch.currentPosition ?? current.currentPosition

    const changed: string[] = []
    if (!sameList(current.longTermConstraints, longTermConstraints)) changed.push('longTermConstraints')
    if (!sameList(current.coherenceRisks, coherenceRisks)) changed.push('coherenceRisks')
    if (!sameList(current.nextChapterPromises, nextChapterPromises)) changed.push('nextChapterPromises')
    if (
      current.currentPosition.volume !== currentPosition.volume ||
      current.currentPosition.chapter !== currentPosition.chapter
    ) {
      changed.push('currentPosition')
    }

    const revision = current.revision + 1
    const committedAt = new Date().toISOString()
    const record: StateTransactionRecord = {
      transactionId: opts.transactionId ?? `stx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      expectedRevision: opts.expectedRevision,
      revision,
      source: opts.source,
      committedAt,
      retiredItems: retired,
      changed,
    }
    const next: TrackingState = {
      ...current,
      currentPosition,
      longTermConstraints,
      coherenceRisks,
      nextChapterPromises,
      revision,
      lastUpdate: committedAt,
      transactions: [...(current.transactions ?? []), record].slice(-50),
    }

    // file.write 内部为「临时文件 + rename」原子写；失败必须上抛，由 UI 提示
    await api().file.write(`content/tracking/${novelId}.json`, JSON.stringify(next, null, 2))
    return { ok: true, state: next }
  })
}

export { AGENT_ROLE_LABELS }
