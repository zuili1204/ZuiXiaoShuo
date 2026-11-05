/**
 * 大纲规划服务（8.13）——真正「写作前」的大纲能力，与 ai-outline 的「从正文反推」互补。
 *
 * 三个核心能力：
 * 1. draftOutlineSeed：弹性输入 → AI 补全提案。用户可只给书名 / 书名+角色 / 角色+类型等任意子集，
 *    缺失维度由 AI 提案（书名备选、类型、梗概、角色阵容），用户确认后才生效。
 * 2. buildProspectiveOutline 系（draftMasterPlan / draftVolumeChapters / applyProspectiveOutline）：
 *    确认立项后生成全书主线 + 分卷规划 + 首卷章纲骨架（纯前瞻规划，不依赖正文），确认后落库。
 * 3. calibrateOutline / applyCalibration：「重订走向」——已写内容的事实 + 现有未写章规划
 *    （+ 作者变更说明）→ 新旧走向对照提案 → 用户勾选采纳 → 回写未写章细纲。
 *
 * 硬红线：已写章（wordCount>0 或磁盘有正文）的摘要/细纲绝不回写。
 *   代码层双重约束：parseRecalibrateDiff 在解析阶段丢弃指向已写章的条目；
 *   applyCalibration 在落库前再次逐章复核。
 *
 * 架构参照 ai-outline.ts / kb-auto-build.ts：async generator + agentChat，空响应重试 2 次。
 */
import type {
  ConfirmedSeed,
  MasterPlan,
  ChapterSkeleton,
  ChapterDetailProposal,
  OutlineReview,
  OutlineReviewIssue,
  OutlineIssueSeverity,
  OutlineIssueType,
  RecalibrateDiff,
  RecalibrateDiffItem,
  OutlineSeed,
  OutlineSeedProposal,
  ProposedCharacter,
  SeedAssistField,
  SeedAssistProposal,
  SeedSuggestion,
  SeedSuggestionFinding,
  Novel,
} from '@shared/types'
import { novelService, volumeService, chapterService, characterService, worldviewService } from './data-service'
import { knowledgeService } from './knowledge-service'
import { extractJson, getAgent, collectVolumes, getChapterDigest, type OutlineProgress, type VolChap } from './ai-outline'
import { callPlanLLM } from './planning-llm'
import { critiquePlan, describeFindings, evaluateSuggestions, type SeedAssistEvaluation } from './planning-critic'
import { loadPlanningStyleContext, planningCraftSection, type PlanningStyleContext } from './planning-style-service'
import { savePlanEvalRun, listPlanEvalRuns } from './planning-eval-service'

/** 规划器进度：在 OutlineProgress 基础上携带各阶段产物，供 UI 渲染提案卡 */
export type PlannerProgress = OutlineProgress & {
  proposal?: OutlineSeedProposal
  masterPlan?: MasterPlan
  chapterSkeletons?: ChapterSkeleton[]
  chapterDetail?: ChapterDetailProposal
  review?: OutlineReview
  diff?: RecalibrateDiff
  /** 单块 AI 规划建议（非完整提案） */
  assist?: SeedAssistProposal
  /** 提案层 warnings（假设/缺口/冲突），不阻断落库 */
  warnings?: string[]
}

// ===== 纯函数：LLM 输出解析（导出供单测） =====

function normalizeRole(value: unknown): ProposedCharacter['role'] {
  const role = String(value ?? '')
  if (role === 'protagonist' || role === '主角') return 'protagonist'
  if (role === 'antagonist' || role === '反派' || role === '对手') return 'antagonist'
  return 'supporting'
}

function normalizeProfile(c: Record<string, unknown>): string {
  if (typeof c.profile === 'string' && c.profile.trim()) return c.profile
  return ['desire', 'obstacle', 'flaw']
    .map((k) => (typeof c[k] === 'string' ? String(c[k]).trim() : ''))
    .filter(Boolean)
    .join('；')
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((v) => v.trim()) : []
}

/** 兼容纯 payload 与统一信封 { stage, baseRevision, payload } 两种输入 */
function unwrapPayload(data: unknown): unknown {
  if (data && typeof data === 'object' && !Array.isArray(data) && (data as any).payload) {
    return (data as any).payload
  }
  return data
}

/** A1 契约 payload → 向导可用提案（兼容旧版 profile 与新版 desire/obstacle/flaw） */
export function parseSeedProposalPayload(payload: unknown): OutlineSeedProposal | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  const titles = textArray(data.titles)
  const characters = Array.isArray(data.characters)
    ? (data.characters as unknown[])
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as any).name === 'string' && !!String((c as any).name).trim())
        .map((c) => ({
          name: String(c.name).trim(),
          role: normalizeRole(c.role),
          profile: normalizeProfile(c),
        }))
    : []
  if (titles.length === 0 && !String(data.premise ?? '').trim()) return null
  return {
    titles,
    genre: typeof data.genre === 'string' ? data.genre : '',
    premise: typeof data.premise === 'string' ? data.premise : '',
    characters,
    synopsis: typeof data.synopsis === 'string' ? data.synopsis : undefined,
    coreConflict: typeof data.coreConflict === 'string' ? data.coreConflict : undefined,
    tone: typeof data.tone === 'string' ? data.tone : undefined,
    audience: typeof data.audience === 'string' ? data.audience : undefined,
    worldAnchors: textArray(data.worldAnchors),
    sellingPoints: textArray(data.sellingPoints),
    warnings: textArray(data.warnings),
  }
}

export function parseSeedProposal(text: string): OutlineSeedProposal | null {
  const jsonStr = extractJson(text)
  if (!jsonStr) return null
  try {
    return parseSeedProposalPayload(unwrapPayload(JSON.parse(jsonStr)))
  } catch {
    return null
  }
}

export function parseMasterPlanPayload(payload: unknown): MasterPlan | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  const masterOutline = typeof data.masterOutline === 'string' ? data.masterOutline : ''
  const volumes = Array.isArray(data.volumes)
    ? (data.volumes as unknown[])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && typeof (v as any).title === 'string' && !!String((v as any).title).trim())
        .map((v) => ({
          title: String(v.title).trim(),
          summary: typeof v.summary === 'string' ? v.summary : '',
          goal: typeof v.goal === 'string' ? v.goal : undefined,
          climax: typeof v.climax === 'string' ? v.climax : undefined,
          endingHook: typeof v.endingHook === 'string' ? v.endingHook : undefined,
          estimatedChapters: Number.isInteger(v.estimatedChapters) ? (v.estimatedChapters as number) : undefined,
          targetWordCount: Number.isInteger(v.targetWordCount) ? (v.targetWordCount as number) : undefined,
        }))
    : []
  if (!masterOutline.trim() && volumes.length === 0) return null
  return {
    masterOutline,
    volumes,
    targetChapters: Number.isInteger(data.targetChapters) ? (data.targetChapters as number) : undefined,
  }
}

export function parseMasterPlan(text: string): MasterPlan | null {
  const jsonStr = extractJson(text)
  if (!jsonStr) return null
  try {
    return parseMasterPlanPayload(unwrapPayload(JSON.parse(jsonStr)))
  } catch {
    return null
  }
}

export function parseChapterSkeletonsPayload(payload: unknown): ChapterSkeleton[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  if (!Array.isArray(data.chapters)) return null
  const chapters = (data.chapters as unknown[])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as any).title === 'string' && !!String((c as any).title).trim())
    .map((c) => ({
      title: String(c.title).trim(),
      hooks: textArray(c.hooks),
      conflict: typeof c.conflict === 'string' ? c.conflict : undefined,
      turn: typeof c.turn === 'string' ? c.turn : undefined,
      payoff: typeof c.payoff === 'string' ? c.payoff : undefined,
      endingType: typeof c.endingType === 'string' ? c.endingType : undefined,
      targetWordCount: Number.isInteger(c.targetWordCount) ? (c.targetWordCount as number) : undefined,
    }))
  if (chapters.length === 0) return null
  return chapters
}

export function parseChapterSkeletons(text: string): ChapterSkeleton[] | null {
  const jsonStr = extractJson(text)
  if (!jsonStr) return null
  try {
    return parseChapterSkeletonsPayload(unwrapPayload(JSON.parse(jsonStr)))
  } catch {
    return null
  }
}

/**
 * A4 章细纲：契约要求 summary + 3-6 条 hooks + 500-20000 目标字数 + continuityNotes 数组。
 * 解析层只做结构兜底，范围校验由 validate-proposal.js 负责。
 */
export function parseChapterDetailPayload(payload: unknown): ChapterDetailProposal | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (!summary) return null
  const hooks = textArray(data.hooks)
  if (hooks.length === 0) return null
  const targetWordCount =
    Number.isInteger(data.targetWordCount) && (data.targetWordCount as number) >= 500 && (data.targetWordCount as number) <= 20000
      ? (data.targetWordCount as number)
      : 3000
  return {
    summary,
    hooks,
    targetWordCount,
    continuityNotes: textArray(data.continuityNotes),
  }
}

const REVIEW_SEVERITIES = new Set<OutlineIssueSeverity>(['blocking', 'warning', 'info'])
const REVIEW_TYPES = new Set<OutlineIssueType>([
  'pacing',
  'logic',
  'motivation',
  'repetition',
  'setup-payoff',
  'hook-density',
  'volume-escalation',
  'chapter-closure',
  'serial-unit',
  'relationship-state',
])

/**
 * 解析 A5 体检结果，并执行补丁红线：指向已写章的 patch 一律丢弃（保留问题本身）。
 * @param opts.resolveChapterId 用卷序+章序反查章 id，用于识别没有 chapterId 的补丁
 */
export function parseOutlineReviewPayload(
  payload: unknown,
  opts: { writtenIds?: Set<string>; resolveChapterId?: (volumeOrder?: number, chapterOrder?: number) => string | undefined } = {},
): OutlineReview | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  const score = typeof data.score === 'number' && data.score >= 0 && data.score <= 100 ? data.score : null
  if (score === null || !Array.isArray(data.issues)) return null

  const writtenIds = opts.writtenIds ?? new Set<string>()
  const issues: OutlineReviewIssue[] = []
  let skipped = 0
  for (const raw of data.issues as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const it = raw as Record<string, unknown>
    const severity = it.severity as OutlineIssueSeverity
    const type = it.type as OutlineIssueType
    if (!REVIEW_SEVERITIES.has(severity) || !REVIEW_TYPES.has(type)) continue
    const id = typeof it.id === 'string' ? it.id.trim() : ''
    const title = typeof it.title === 'string' ? it.title.trim() : ''
    const description = typeof it.description === 'string' ? it.description.trim() : ''
    const suggestion = typeof it.suggestion === 'string' ? it.suggestion.trim() : ''
    if (!id || !title || !description || !suggestion) continue

    const volumeOrder = Number.isInteger(it.volumeOrder) ? (it.volumeOrder as number) : undefined
    const chapterOrder = Number.isInteger(it.chapterOrder) ? (it.chapterOrder as number) : undefined
    const chapterId = typeof it.chapterId === 'string' ? it.chapterId : undefined

    let patch: OutlineReviewIssue['patch']
    if (it.patch && typeof it.patch === 'object' && !Array.isArray(it.patch)) {
      const p = it.patch as Record<string, unknown>
      const patchSummary = typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim() : undefined
      const patchHooks = textArray(p.hooks)
      if (patchSummary || patchHooks.length > 0) {
        patch = { summary: patchSummary, hooks: patchHooks.length > 0 ? patchHooks : undefined }
        const targetId = chapterId ?? opts.resolveChapterId?.(volumeOrder, chapterOrder)
        if (targetId && writtenIds.has(targetId)) {
          patch = undefined
          skipped++
        }
      }
    }

    issues.push({ id, severity, type, volumeOrder, chapterOrder, chapterId, title, description, suggestion, patch })
  }

  return {
    score,
    issues,
    summary: typeof data.summary === 'string' ? data.summary : '',
    skipped,
  }
}

/**
 * 解析重订走向 diff，并执行第一条红线：只保留指向「未写章」的条目。
 * @param unwrittenMap 未写章索引：chapterId → 该章的卷/章信息与当前 hooks
 */
export function parseRecalibrateDiffPayload(
  payload: unknown,
  unwrittenMap: Map<string, { volumeId: string; volumeOrder: number; chapterOrder: number; chapterTitle: string; oldHooks: string[] }>,
): RecalibrateDiff | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  // A6 新契约用 diffs，旧版用 items
  const rawItems = Array.isArray(data.diffs)
    ? (data.diffs as unknown[])
    : Array.isArray(data.items)
      ? (data.items as unknown[])
      : []
  const items: RecalibrateDiffItem[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    if (typeof it.chapterId !== 'string') continue
    const target = unwrittenMap.get(it.chapterId)
    if (!target) continue // 红线：指向已写章 / 未知章的条目直接丢弃
    const newHooks = textArray(it.newHooks)
    if (newHooks.length === 0) continue
    items.push({
      chapterId: it.chapterId,
      volumeId: target.volumeId,
      volumeOrder: target.volumeOrder,
      chapterOrder: target.chapterOrder,
      chapterTitle: target.chapterTitle,
      oldHooks: target.oldHooks,
      newHooks,
      reason: typeof it.reason === 'string' ? it.reason : '',
      rippleEffects: textArray(it.rippleEffects),
    })
  }
  return {
    summary: typeof data.summary === 'string' ? data.summary : '',
    items,
    skipped: rawItems.length - items.length,
  }
}

export function parseRecalibrateDiff(
  text: string,
  unwrittenMap: Map<string, { volumeId: string; volumeOrder: number; chapterOrder: number; chapterTitle: string; oldHooks: string[] }>,
): RecalibrateDiff | null {
  const jsonStr = extractJson(text)
  if (!jsonStr) return null
  try {
    const data = JSON.parse(jsonStr) as unknown
    return parseRecalibrateDiffPayload(unwrapPayload(data), unwrittenMap)
  } catch {
    return null
  }
}

/**
 * 章节读写状态二分：未写章 = wordCount 为 0 且磁盘无正文。
 * contents 为 chapterId → 磁盘正文 的预载映射（由调用方批量读取）。
 */
export function splitWrittenUnwritten(
  chapters: { id: string; wordCount: number; volumeId: string; order: number; title: string; hooks?: string[] }[],
  contents: Record<string, string>,
): {
  written: { id: string; volumeId: string; order: number; title: string }[]
  unwritten: { id: string; volumeId: string; order: number; title: string; hooks: string[] }[]
} {
  const written: { id: string; volumeId: string; order: number; title: string }[] = []
  const unwritten: { id: string; volumeId: string; order: number; title: string; hooks: string[] }[] = []
  for (const ch of chapters) {
    const hasDisk = !!(contents[ch.id] && contents[ch.id].trim())
    if (ch.wordCount > 0 || hasDisk) written.push({ id: ch.id, volumeId: ch.volumeId, order: ch.order, title: ch.title })
    else unwritten.push({ id: ch.id, volumeId: ch.volumeId, order: ch.order, title: ch.title, hooks: (ch.hooks ?? []).map(String) })
  }
  return { written, unwritten }
}

/** 前瞻性大纲 markdown（prose 版，含章骨架；落库后写入 KB outline.md） */
export function buildProspectiveOutlineMd(confirmed: ConfirmedSeed, masterPlan: MasterPlan, firstVolumeChapters: ChapterSkeleton[]): string {
  const L: string[] = []
  L.push(`# 全书大纲（《${confirmed.title}》· ${confirmed.genre || '未分类'}）`)
  L.push('')
  L.push('## 主线')
  L.push(masterPlan.masterOutline || '（待补充）')
  L.push('')
  L.push('## 分卷规划')
  L.push('')
  masterPlan.volumes.forEach((v, i) => {
    L.push(`### 第${i + 1}卷《${v.title}》`)
    L.push(`卷纲：${v.summary || '（待补充）'}`)
    if (v.goal) L.push(`卷目标：${v.goal}`)
    if (v.climax) L.push(`卷末高潮：${v.climax}`)
    if (v.endingHook) L.push(`卷尾钩子：${v.endingHook}`)
    if (v.estimatedChapters) L.push(`预计章数：${v.estimatedChapters}`)
    if (v.targetWordCount) L.push(`目标字数：${v.targetWordCount}`)
    L.push('')
    if (i === 0 && firstVolumeChapters.length > 0) {
      firstVolumeChapters.forEach((c, j) => {
        L.push(`- 第${j + 1}章《${c.title}》：${c.hooks.join('；') || '（骨架待细化）'}`)
      })
      L.push('')
    }
  })
  return L.join('\n')
}

/** 组装用户弹性输入的线索文本（「（未提供）」占位缺失维度） */
export function buildSeedSeedSection(seed: OutlineSeed): string {
  const line = (label: string, value?: string) =>
    `- ${label}：${value?.trim() || '（未提供）'}`
  const lines = [
    line('书名', seed.title),
    line('类型', seed.genre),
    line('一句话梗概', seed.premise),
    line('核心冲突', seed.coreConflict),
    line('主角', seed.protagonist),
    line('其他角色', seed.characters),
    line('世界观与设定', seed.worldview),
    line('时代与地点', seed.setting),
    line('金手指/核心能力', seed.power),
    line('卖点与爽点', seed.sellingPoints),
    line('基调与读者', seed.tone),
    line('对标作品', seed.references),
    line('禁忌与雷点', seed.taboos),
    line('草稿区（作者随手记录，需整理后采纳）', seed.draft),
    `- 期望卷数：${seed.volumeCount && seed.volumeCount > 0 ? String(seed.volumeCount) : '（未提供）'}`,
    `- 期望总章数：${seed.chapterCount && seed.chapterCount > 0 ? String(seed.chapterCount) : '（未提供）'}`,
  ]
  return lines.join('\n')
}

// ===== 1. 弹性输入 → AI 补全提案 =====

/** 作者本次方向：口味、禁忌、参考片段；附在任务末尾，为空则不加 */
function notesSection(notes?: string): string {
  const text = notes?.trim()
  return text
    ? `\n\n==== 作者方向（优先遵守，但不得违背上面已填线索中的事实）====\n${text.slice(0, 3000)}\n`
    : ''
}

/** 当下网文/轻小说的默认阅读期待：先立住可写的场面与爽点，不默认套苦情框架 */
const MODERN_TASTE_RULES =
  '写作口味（默认，除非作者方向中另行要求）：\n' +
  '- 按当下网文/轻小说的阅读期待：开篇有钩子，设定能制造名场面、关系推进和可预期的爽点/甜点\n' +
  '- 先设计能反复发生的单元：固定地点、固定仪式、固定几个人，每周都能再来一次\n' +
  '- 关系写成状态机：当前标签 → 升级条件 → 退化条件；不要只写「关系很好」\n' +
  '- 章末停在画面/动作/台词/信息/未完成动作/误会之一，禁止总结、升华、点题\n' +
  '- 不要默认套用「枷锁、代价、倒计时、宿命、献祭」等苦情框架，也不要十年前的青春疼痛腔\n' +
  '- 设定先回答「能发生什么好看的事」，而不是「如何惩罚主角」；代价可以有，但要轻、可控、服务剧情\n' +
  '- 不要模板腔：少用「他必须在…的同时…」「代价是…」「越…越…」「四段/四份真心」「不伤任何人」；不要用「真心、宿命、救赎、债」这类大词收尾\n' +
  '- 具体优先：写人名、动作、场景、对话或一个能发生的画面，不要用抽象总结代替内容\n' +
  '- 决策优先：每个桥段至少有一个角色在具体处境里做选择；选择要改变关系、信息或局面，不能只写「发生了一件事」\n' +
  '- 长短错开：多条候选不要都写成同样字数、同样起承转合；至少一条短促收尾，一条展开到具体场面\n' +
  '- 短句与人味：能用句号断开就不用破折号压缩；允许一句人物的内心短句（如「不对呀……」），让反应发生在人物心里；结尾不写作者的客观总结\n' +
  '- 人物不要写成设定档案：禁止「功能 / 缺口 / 关系标签 / 口头禅」这类字段清单，也不要人人配齐三件套；用一两句具体动作、台词或场面把人立住，细节宁可不对称\n' +
  '- 简介写法对比：坏例「他必须在X的同时Y，代价是Z」；好例「某人只想A，直到B发生」——先给一个具体事件或画面，再留钩子\n' +
  '- 忠实素材：用户草稿里已有的能力名、人物名与关系必须原样使用，不新增、不改名、不合并（例如「回声定位」不要写成「雷达」）\n' +
  '- 对标作品只学机制、节奏与氛围，不照搬情节\n'

function planFindingsToWarnings(findings?: SeedSuggestionFinding[]): string[] {
  return (findings ?? [])
    .filter((f) => f.severity !== 'info')
    .map((f) => `整体体检：${f.message}${f.location ? `（${f.location}）` : ''}`)
}

function planCritiqueWarnings(evaluation: SeedAssistEvaluation): string[] {
  return planFindingsToWarnings(evaluation.planCritique?.findings)
}

function lintSeedProposal(proposal: OutlineSeedProposal): SeedAssistEvaluation {
  const items: SeedSuggestion[] = [
    ...proposal.titles.map((t) => ({ text: t, axis: '书名' })),
    { text: proposal.premise, axis: '梗概', scene: proposal.synopsis },
    ...(proposal.coreConflict ? [{ text: proposal.coreConflict, axis: '核心冲突' }] : []),
    ...(proposal.sellingPoints ?? []).map((s) => ({ text: s, axis: '卖点' })),
    ...(proposal.worldAnchors ?? []).map((s) => ({ text: s, axis: '世界观' })),
    ...proposal.characters.map((c) => ({ text: `${c.name}：${c.profile}`, axis: '角色' })),
  ].filter((item) => item.text?.trim())
  return evaluateSuggestions(items, 'premise')
}

export async function* draftOutlineSeed(
  novelId: string,
  seed: OutlineSeed,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  yield { phase: 'prepare', message: '正在整理你的创作线索…' }
  const styleCtx = await loadPlanningStyleContext(novelId)
  if (signal?.aborted) return
  yield { phase: 'llm', message: '正在生成立项提案…' }
  const baseRevision = `draft-${Date.now()}`
  const task =
    '你是一名小说立项策划。用户给出了部分创作线索（可能缺失多个维度），请补全缺失维度并输出立项提案。\n' +
    '已提供线索：\n' +
    buildSeedSeedSection(seed) + '\n\n' +
    '（某项为「（未提供）」表示用户未填写，由你提案；用户已提供的项必须原样保留、围绕它展开，不得擅自更改。世界设定、主角、基调与禁忌尤其要尊重，不得改写成常见的套路。草稿区是作者随手记录，可能有矛盾或未成形，请整理成可用设定后采纳，但不要忽略。）\n\n' +
    planningCraftSection(styleCtx, 'seed') + '\n\n' +
    MODERN_TASTE_RULES +
    '\n本次要求：\n' +
    '- titles：用户已给书名时只返回该书名一个元素；未给时给 3 个贴合已有线索的备选\n' +
    '- characters：3~6 个，必须包含主角；用户在「主角」「其他角色」线索中给出的人物必须收录、按原设定完善，不得魔改人设\n' +
    '- worldAnchors：3~5 条，只列会驱动剧情、能反复制造事件的世界铁律\n' +
    '- sellingPoints：3~5 条可复用爽点/看点，每条写成一个具体场面\n' +
    '- coreConflict：写成双方在具体事上的选择对抗，不写抽象立场；第一次冲突要能落到一个场面上\n' +
    '- premise 像网文简介：谁 + 处境/能力 + 最抓人的关系或麻烦 + 可期待的名场面；短句、具体，不要每句以「代价」收尾；synopsis 200 字内' +
    notesSection(notes)

  const result = await callPlanLLM(agent, novelId, 'seed', task, { signal, baseRevision })
  if (signal?.aborted) return
  const proposal = parseSeedProposalPayload(result.payload)
  if (!proposal) {
    yield { phase: 'error', message: 'AI 输出无法解析为提案，请重试' }
    return
  }

  const evaluation = lintSeedProposal(proposal)
  const lintWarnings = evaluation.summary.findings
    .filter((f) => f.severity !== 'info')
    .map((f) => `规划体检：${f.message}`)
  proposal.warnings = [
    ...new Set([...(proposal.warnings ?? []), ...result.warnings, ...lintWarnings, ...planCritiqueWarnings(evaluation)]),
  ]
  await savePlanEvalRun({
    novelId,
    stage: 'seed',
    baseRevision,
    summary: evaluation.summary,
    model: agent.model,
  })
  yield {
    phase: 'done',
    message: '提案已生成，请确认或修改',
    proposal,
    warnings: proposal.warnings,
  }
}

// ===== 1.5 逐块 AI 规划：只补一个线索块，始终携带其余已填线索 =====

export const SEED_ASSIST_LABEL: Record<SeedAssistField, string> = {
  genre: '类型',
  title: '书名',
  premise: '一句话梗概',
  coreConflict: '核心冲突',
  protagonist: '主角',
  characters: '其他角色',
  worldview: '世界观与设定',
  setting: '时代与地点',
  power: '金手指 / 核心能力',
  sellingPoints: '卖点与爽点',
  tone: '基调与读者',
  references: '对标作品',
  taboos: '禁忌与雷点',
}

const SEED_ASSIST_BRIEF: Record<SeedAssistField, string> = {
  genre: '给 3~4 个题材/标签组合，如「都市悬疑 / 校园异能」。每个建议只写类型本身，不要展开。',
  title:
    '给 3~5 个书名，每个 4~12 字，贴合类型与核心冲突，彼此差异明显；避免「觉醒XX的我被XX了」这类过时轻小说套路，优先口语化、有具体钩子的名字。三条候选尽量分别走轻喜剧/关系流/悬疑感三种味道。',
  premise:
    '给 2~3 个「开场就能拍」的一句话梗概，每条 40~120 字，且三条之间长短错开：至少一条压到 50 字以内，至少一条展开到 90 字以上。第一句直接写人物正在做的事或正在发生的事，不要先介绍学校、身份与背景；结尾停在一个动作、一句台词或一个具体物件上，不要从背景一路讲到现状，也不要用「四个X、一本Y、一个Z」式清单收尾。三条候选分别走不同轴（例如 轻喜剧 / 关系流 / 悬疑感），每条都在 scene 里写一个能反复发生的场面。三条的落点要错开：一条停在台词，一条停在动作，一条停在信息揭示或未完成动作；每条至少有一个明确的答应、拒绝、隐瞒或交换，并写出它带来的直接后果。结尾优先停在人物的即时反应或没说完的话上，不要用「他记得是 X，本子上写着 Y」这种客观对照收尾；短句优先，能断句就不要用破折号把两条信息压进一句。节奏参考（只学断句与落点，不要复用内容）：同桌把橡皮掰成两半，推了一半过来。不对呀，这道题他做过，明明记得自己写的是2，本子上却是3。',
  coreConflict:
    '给 2~3 条核心冲突，写清谁和谁在争什么、为什么好看或好笑；不要抽象成「不伤任何人」式的道德难题，也不要强行加悲剧代价。冲突要能反复发生，而不是只打一次就结束。',
  protagonist:
    '给 1~2 个主角方案。用 2~3 句写成能直接拍出来的片段：他在什么场合、做了什么、说了哪一句，让人记住；可以写他让人头疼的地方。不要列「身份 / 欲望 / 阻碍 / 缺陷」字段，也不要配齐口头禅；只留一个最不对称、最像真人的细节。',
  characters:
    '给 1~2 套角色阵容。已填角色必须保留姓名与关系，但不要逐人展开。每套只展开 2 人：一个人用 2~3 句写一个能拍的场面（动作 + 台词），另一个人只写一句怪习惯或一句台词，允许留白；其余已填角色只列名字和一句关系。禁止字段清单（功能 / 缺口 / 关系标签 / 口头禅），禁止在名字后堆身份标签（如「校花·姐姐·邻居」），身份放进动作里。不要每段都用「麻烦是…」「越界的方式是…」「底线是…」这类排比，也不要给每个人都安排金句与反差萌；病娇等标签要保留可爱面与底线。',
  worldview:
    '给 2~3 组世界观与能力设定，每组 3~6 行，格式「设定名：内容」。优先写这些设定在校园日常里能制造什么名场面、怎么推进关系、读者会期待什么；写明边界即可，不要堆代价、枷锁、倒计时或宿命惩罚。至少让其中一条规则可以反复触发同一类场面。',
  setting: '给 2~3 个时代与地点方案，写清时间、空间与它们带来的日常机会和麻烦；优先选择能反复发生事件的固定场所。',
  power:
    '给 2~3 套金手指/能力方案。每套写清触发条件、能制造的日常爽点与暧昧场面、边界与轻代价；代价必须服务喜剧和关系推进，不要越用越惨，也不要不可逆消耗。每条都给出一个「每周都能再用一次」的固定场面。',
  sellingPoints:
    '给 1~2 组卖点，每组 3~5 条。每条必须是一个能直接开写的具体场面或期待点（例如「校庆前交换值日表」「把旧书摊开到操场边」），不要抽象口号。三条以上时尽量覆盖不同功能位：进度条/仪式/亲密借口/关系地图/安全阀。',
  tone: '给 2~3 条基调与读者定位，用当下网文标签描述（如 中式轻小说 / 多女主 / 搞笑轻松 / 超能力 / 恋爱暧昧），不要写成严肃文学或十年前的青春疼痛。',
  references: '给 2~3 组对标作品，写清可借鉴的机制、节奏与氛围，不要照搬情节。',
  taboos: '给 2~3 组禁忌与雷点，写清不要出现的内容与边界。',
}

const SEED_ASSIST_FIELDS = new Set<SeedAssistField>(
  Object.keys(SEED_ASSIST_LABEL) as SeedAssistField[],
)

/** 只重写措辞、不改事实的叙事类字段；类型/书名/设定类不走二次改句 */
const HUMANIZE_FIELDS = new Set<SeedAssistField>([
  'premise',
  'coreConflict',
  'protagonist',
  'characters',
  'sellingPoints',
])

export function isHumanizeField(field: SeedAssistField): boolean {
  return HUMANIZE_FIELDS.has(field)
}

function parseSuggestionItem(raw: unknown): SeedSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 4000) : ''
  if (!text) return null
  return {
    text,
    axis: typeof o.axis === 'string' && o.axis.trim() ? o.axis.trim().slice(0, 40) : undefined,
    scene: typeof o.scene === 'string' && o.scene.trim() ? o.scene.trim().slice(0, 400) : undefined,
    functionPositions: textArray(o.functionPositions).map((p) => p.trim().slice(0, 20)).slice(0, 3),
    whyItWorks:
      typeof o.whyItWorks === 'string' && o.whyItWorks.trim()
        ? o.whyItWorks.trim().slice(0, 200)
        : undefined,
    risks: textArray(o.risks).map((r) => r.trim().slice(0, 200)).slice(0, 3),
  }
}

export function parseSeedAssistPayload(payload: unknown): SeedAssistProposal | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const data = payload as Record<string, unknown>
  const field = typeof data.field === 'string' ? data.field.trim() : ''
  if (!SEED_ASSIST_FIELDS.has(field as SeedAssistField)) return null

  const seen = new Set<string>()
  const items: SeedSuggestion[] = []
  const push = (item: SeedSuggestion) => {
    const text = item.text.trim().slice(0, 4000)
    if (!text || seen.has(text) || items.length >= 5) return
    seen.add(text)
    items.push({ ...item, text })
  }

  // items 优先；suggestions 只补 items 没覆盖到的文本
  if (Array.isArray(data.items)) {
    for (const raw of data.items) {
      const item = parseSuggestionItem(raw)
      if (item) push(item)
    }
  }
  for (const raw of textArray(data.suggestions)) push({ text: raw })
  if (items.length === 0) return null

  return {
    field: field as SeedAssistField,
    suggestions: items.map((item) => item.text),
    items,
    reason:
      typeof data.reason === 'string' && data.reason.trim()
        ? data.reason.trim().slice(0, 400)
        : undefined,
    warnings: textArray(data.warnings),
  }
}

/**
 * 单块规划任务：只问一个块，但强制带上全部已填线索、草稿区与作者方向，
 * 这样逐级推进和回头重规划都能前后呼应。
 */
function buildSeedAssistSchema(field: SeedAssistField): string {
  return (
    '输出 payload 结构（必须严格遵守）：\n' +
    `{"field":"${field}","suggestions":["第 1 条完整建议","第 2 条完整建议"],` +
    '"items":[{"text":"可直接填入该字段的完整文本","axis":"候选轴，如 轻喜剧/关系流/悬疑感/日常仪式",' +
    '"scene":"一个能发生、可重复的具体场面","functionPositions":["可见进度条/可重复仪式/合法亲密借口/公开关系地图/元叙事安全阀，命中的写 1-3 个"],' +
    '"whyItWorks":"一句可核对的事实：可复用的机制或固定场面，≤20 字，不写评价","risks":["与已填线索的冲突或风险"]}],' +
    '"reason":"一句话说明取舍，≤40 字","warnings":["只在真正冲突或必须作者决策时填写"]}\n' +
    `- field 必须原样填写 "${field}"\n` +
    '- whyItWorks 只写机制或固定场面，不写「好看/笑点/读者会期待/现成」这类评价\n' +
    '- reason 只写取舍（例如「更偏轻喜剧，保留原人物关系」），不点评已填内容、不复述指令；warnings 只写真正的设定冲突或需要作者拍板的选择，没有就返回空数组\n' +
    '- suggestions 为 1~5 条字符串，必须与 items 的 text 一一对应、顺序一致；warnings 没有也要返回空数组\n' +
    '- items 与 suggestions 数量一致；每条 item 都要有 text、axis、scene，functionPositions/whyItWorks/risks 尽量给全\n' +
    '- text 是要填进作者设定里的正文，不是分析报告：不要写「功能：」「缺口：」「关系标签：」这类字段，分析只放进 whyItWorks/risks\n' +
    '- 多条候选必须沿不同轴发散，不要给三条同一个答案的三种措辞'
  )
}

export function buildSeedAssistTask(
  field: SeedAssistField,
  seed: OutlineSeed,
  notes?: string,
  styleCtx?: PlanningStyleContext | null,
): string {
  const label = SEED_ASSIST_LABEL[field]
  return (
    `你是一名小说策划，只负责补全或重规划一个线索块：${label}。\n\n` +
    '已填线索（务必与之协调）：\n' +
    buildSeedSeedSection(seed) + '\n\n' +
    `本块要求：${SEED_ASSIST_BRIEF[field]}\n\n` +
    planningCraftSection(styleCtx, 'seed-assist') + '\n\n' +
    buildSeedAssistSchema(field) + '\n\n' +
    MODERN_TASTE_RULES + '\n' +
    '规则：\n' +
    '- 只输出本块的 suggestions/items，不要越界生成其他块的内容\n' +
    '- 每条建议必须是可直接填入该字段的完整文本；多行字段用换行分隔\n' +
    '- 每条建议至少能落到一个具体人物、物件、地点或动作上；写不出场面就重写\n' +
    '- 每条建议至少包含一个角色选择或一个会改变局面的动作，不要只描述状态\n' +
    '- 叙事类字段直接从人物正在做的事写起，不要用「某校高三男生 / 名下有楼」这类背景介绍开头；最后一句停在动作、台词或具体物件上，不要用清单式排比收尾\n' +
    '- 严格遵守「本块要求」里的字数与长短差；超了就删背景，不删具体动作\n' +
    '- 用户已明确写下的内容必须尊重；本块已有内容时，给出明显不同且更好的替代方案，而不是复述\n' +
    '- 草稿区是作者随手记录，可能有矛盾或未成形，整理后采纳，但不要忽略\n' +
    '- 线索互相冲突时，在 warnings 中指出冲突，并优先尊重用户明确写下的设定\n' +
    '- 不要空泛套话；每条建议都要有具体信息\n' +
    notesSection(notes)
  )
}

function buildSeedAssistRewriteTask(
  field: SeedAssistField,
  seed: OutlineSeed,
  assist: SeedAssistProposal,
  evaluation: SeedAssistEvaluation,
  notes?: string,
  styleCtx?: PlanningStyleContext | null,
): string {
  const label = SEED_ASSIST_LABEL[field]
  const issues = evaluation.items
    .map((item, i) => {
      const detail = describeFindings(item.findings ?? []) || '- 未命中模板，但请继续保持具体场面'
      return `${i + 1}. ${item.text}\n   问题：\n${detail}`
    })
    .join('\n')
  const planIssues = (evaluation.planCritique?.findings ?? [])
    .filter((f) => f.severity !== 'info')
    .map((f) => `- ${f.message}${f.location ? `（${f.location}）` : ''}${f.evidence ? `：${f.evidence}` : ''}`)
    .join('\n')
  return (
    `你是一名小说策划。上一批「${label}」建议命中了过时模板或“不可写”问题，请重写。\n\n` +
    '已填线索（必须保留其中的人名、能力名与关系，不得改写）：\n' +
    buildSeedSeedSection(seed) + '\n\n' +
    `本块要求：${SEED_ASSIST_BRIEF[field]}\n\n` +
    `上一批建议与问题：\n${issues}\n\n` +
    (planIssues ? `整份建议的问题：\n${planIssues}\n\n` : '') +
    (assist.reason ? `上一批的理由：${assist.reason}\n\n` : '') +
    planningCraftSection(styleCtx, 'seed-assist') + '\n\n' +
    buildSeedAssistSchema(field) + '\n\n' +
    MODERN_TASTE_RULES + '\n' +
    '重写规则：\n' +
    '- 保留原建议里可用的具体素材（人名、能力名、关系、场面），只替换模板化表达与抽象总结\n' +
    '- 先删掉背景介绍与结论句：从人物正在做的事写起，最后停在人物的即时反应、动作、台词或物件上\n' +
    '- 把「——他记得是 X，本子上写着 Y」这类客观对照拆成短句，改成人物当下的怀疑或反应\n' +
    '- whyItWorks 压到 20 字以内，只留机制或固定场面；reason 不点评上一批，warnings 没有就留空\n' +
    '- 如果是人物块：把「姓名（身份）—— 功能 / 缺口 / 口头禅」这类档案改写成 2~3 句具体场面或台词，只保留一个不对称细节，不要人人配齐三件套\n' +
    '- 每条都必须能落到一个具体人物、物件、地点或动作上；写不出场面就换成能写的\n' +
    '- 三条候选仍走不同轴；不要用“代价/宿命/救赎/倒计时/全员告白/不伤任何人”收尾\n' +
    '- 不要解释为什么改，直接输出新的 JSON\n' +
    notesSection(notes)
  )
}

/** 作者样例：只学断句与落点，禁止复用其中的人物、道具与情节 */
const HUMANIZE_STYLE_CONTRACT =
  '风格契约（只学断句与落点，示例里的人名、道具、事件都不得写进建议）：\n' +
  '压缩版：早读铃响，他把练习册推给同桌：「这题你替我写的？」同桌没抬头，把橡皮掰成两半，一半推回来——同一道题，他记得是2，本子上写着3。\n' +
  '人味版：早读铃响，他把练习册推给同桌：「这题你替我写的？」同桌没抬头，把橡皮掰成两半，推了一半过来。不对呀，这道题他做过，明明记得自己写的是2，本子上却是3。\n' +
  '差别：压缩版用破折号把动作、解释和结论压进一句，最后落在客观对照上；人味版用句号断开动作，把怀疑放进人物心里，最后停在人物当下的反应上。'

export function buildSeedHumanizeTask(
  field: SeedAssistField,
  seed: OutlineSeed,
  items: SeedSuggestion[],
  styleCtx?: PlanningStyleContext | null,
): string {
  const label = SEED_ASSIST_LABEL[field]
  const blocks = items
    .map((item, i) => {
      const axis = item.axis ? `【${item.axis}】` : ''
      const why = item.whyItWorks ? `\n   说明：${item.whyItWorks}` : ''
      return `${i + 1}.${axis}${item.text}${why}`
    })
    .join('\n')
  return (
    `你是一名小说编辑，只做一件事：按作者的节奏把已有的「${label}」建议改一遍句子。\n\n` +
    '已填线索（用于核对事实，不是改写对象）：\n' +
    buildSeedSeedSection(seed) + '\n\n' +
    '需要改句的建议：\n' + blocks + '\n\n' +
    HUMANIZE_STYLE_CONTRACT + '\n\n' +
    '改句规则：\n' +
    '- 只改写 text 与 whyItWorks；事实、人物、关系、数字、专有名词、引号里的内容必须原样保留，不新增也不删减情节\n' +
    '- 改句不是重写：原文每个信息点都要在改写后找到对应，不能新增句子、新事件或新道具；只允许把一句拆成两句，不允许凭空加戏\n' +
    '- 人物名、能力名、地名、书名一律不改；不新增人物、地点、道具或事件\n' +
    '- 按人味版的做法：把破折号压缩的长句拆成短句；把作者的客观对照改成人物当下的反应或没说出口的话；结尾停在动作、台词或一个具体物件上\n' +
    '- 保留原有落点与长短差：原来停台词、停动作、停信息揭示的就照旧，不要把三条都改成同一种收尾或同一长度；原文最后揭示的事实或动作不能删，不能停在「不对呀」这种半句上\n' +
    '- 每条保持原候选的轴、场面与功能位，不合并、不换题；候选数量与顺序保持不变\n' +
    '- 如果某条已经足够自然，就原样返回它的 text\n' +
    '- 不写解释、不写评价，只输出改好的 JSON\n\n' +
    planningCraftSection(styleCtx, 'seed-assist') + '\n\n' +
    '输出 payload 结构（必须严格遵守）：\n' +
    `{"field":"${field}","suggestions":["改好的第 1 条","改好的第 2 条"],` +
    '"items":[{"text":"改好的完整文本","whyItWorks":"≤20 字，只写机制或固定场面"}]}\n' +
    '- suggestions 与 items 的 text 一一对应、顺序一致；items 数量与顺序必须和输入一一对应\n' +
    '- whyItWorks 只写机制或固定场面，不写「好看/笑点/读者会期待」这类评价'
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 事实令牌：数字与引号内的原话，二次改句必须原样保留 */
export function factTokens(text: string): string[] {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/\d+(?:\.\d+)?/g)) tokens.add(match[0])
  for (const match of text.matchAll(/[「『“"《]([^」』”"》]{1,40})[」』”"》]/g)) {
    const inner = match[1].trim()
    if (inner) tokens.add(inner)
  }
  return [...tokens]
}

function keepsFactToken(token: string, text: string): boolean {
  if (/^\d/.test(token)) {
    return new RegExp(`(^|\\D)${escapeRegExp(token)}(?!\\d)`).test(text)
  }
  return text.includes(token)
}

export function humanizeKeepsFacts(original: string, rewritten: string): boolean {
  const before = factTokens(original)
  const after = new Set(factTokens(rewritten))
  if (before.length !== after.size) return false
  if (!before.every((token) => keepsFactToken(token, rewritten))) return false
  // 只改句不该扩写成新事件：长文本长度变化控制在 ±35%
  if (original.trim().length >= 40) {
    const ratio = rewritten.trim().length / original.trim().length
    if (ratio < 0.65 || ratio > 1.35) return false
  }
  return true
}

/** 只替换 text/whyItWorks，保留原候选的轴、场面、功能位与风险 */
export function applyHumanizedItems(
  originals: SeedSuggestion[],
  rewritten: SeedSuggestion[],
): SeedSuggestion[] | null {
  if (rewritten.length !== originals.length) return null
  const merged = originals.map((original, i) => ({
    ...original,
    text: rewritten[i].text,
    whyItWorks: rewritten[i].whyItWorks ?? original.whyItWorks,
  }))
  if (!merged.every((item, i) => humanizeKeepsFacts(originals[i].text, item.text))) return null
  return merged
}

/**
 * 单块 AI 规划：作者点某个块时，携带所有已填线索（含草稿区）重新生成该块，
 * 因此先定类型再起书名、之后回头改书名都能前后呼应。
 * 生成后先跑本地批评器；命中 blocking 模板时自动重写一次。
 */
export async function* draftSeedField(
  novelId: string,
  field: SeedAssistField,
  seed: OutlineSeed,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  const label = SEED_ASSIST_LABEL[field]
  yield { phase: 'prepare', message: `正在整理与「${label}」相关的线索…` }
  const styleCtx = await loadPlanningStyleContext(novelId)
  if (signal?.aborted) return
  yield { phase: 'llm', message: `正在生成「${label}」建议…` }

  const baseRevision = `assist-${Date.now()}`
  const result = await callPlanLLM(agent, novelId, 'seed-assist', buildSeedAssistTask(field, seed, notes, styleCtx), {
    signal,
    baseRevision,
  })
  if (signal?.aborted) return

  const payload = result.payload as Record<string, unknown>
  let assist = parseSeedAssistPayload({ ...payload, field })
  if (!assist) {
    yield { phase: 'error', message: 'AI 返回的建议无法解析，请重试' }
    return
  }

  let evaluation = evaluateSuggestions(assist.items ?? [], field)
  const warnings = [...assist.warnings, ...result.warnings]
  const planBlocking = (evaluation.planCritique?.findings ?? []).some((f) => f.severity === 'blocking')

  if (evaluation.summary.blocking > 0 || planBlocking) {
    yield { phase: 'llm', message: '检测到模板化表达，正在自动重写…' }
    try {
      const rewritten = await callPlanLLM(
        agent,
        novelId,
        'seed-assist',
        buildSeedAssistRewriteTask(field, seed, assist, evaluation, notes, styleCtx),
        { signal, baseRevision: `rewrite-${Date.now()}` },
      )
      if (signal?.aborted) return
      const next = parseSeedAssistPayload({ ...(rewritten.payload as Record<string, unknown>), field })
      if (next) {
        const nextEval = evaluateSuggestions(next.items ?? [], field)
        const improved =
          nextEval.summary.blocking < evaluation.summary.blocking ||
          nextEval.summary.score > evaluation.summary.score ||
          (nextEval.planCritique?.score ?? 0) > (evaluation.planCritique?.score ?? 0)
        if (improved) {
          assist = { ...next, rewritten: true, warnings: [...next.warnings, ...rewritten.warnings] }
          evaluation = nextEval
          warnings.push('已自动重写模板化建议')
        } else {
          warnings.push('自动重写未明显改善，已保留原建议')
        }
      }
      warnings.push(...rewritten.warnings)
    } catch (e) {
      console.warn('[plan] seed-assist rewrite failed:', e)
      warnings.push('自动重写失败，已保留原建议')
    }
  }

  const currentItems = assist.items ?? []
  if (isHumanizeField(field) && currentItems.length > 0) {
    yield { phase: 'llm', message: '正在按你的节奏调整句子…' }
    try {
      const humanized = await callPlanLLM(
        agent,
        novelId,
        'seed-assist',
        buildSeedHumanizeTask(field, seed, currentItems, styleCtx),
        { signal, baseRevision: `humanize-${Date.now()}` },
      )
      if (signal?.aborted) return
      const parsed = parseSeedAssistPayload({ ...(humanized.payload as Record<string, unknown>), field })
      const nextItems = parsed ? applyHumanizedItems(currentItems, parsed.items ?? []) : null
      if (nextItems) {
        const nextEval = evaluateSuggestions(nextItems, field)
        const blockingWorse = nextEval.summary.blocking > evaluation.summary.blocking
        const scoreWorse =
          nextEval.summary.score < evaluation.summary.score - 5 ||
          (nextEval.planCritique?.score ?? 0) < (evaluation.planCritique?.score ?? 0) - 5
        if (!blockingWorse && !scoreWorse) {
          const changed = nextItems.some((item, i) => item.text !== currentItems[i]?.text)
          assist = {
            ...assist,
            items: nextItems,
            suggestions: nextItems.map((item) => item.text),
            humanized: changed || assist.humanized,
            warnings: [...assist.warnings, ...humanized.warnings],
          }
          evaluation = nextEval
        } else {
          warnings.push('按节奏改句未通过体检，已保留原建议')
        }
      } else {
        warnings.push('按节奏改句改动了事实，已保留原建议')
      }
      warnings.push(...humanized.warnings)
    } catch (e) {
      if (signal?.aborted) return
      console.warn('[plan] seed-assist humanize failed:', e)
      warnings.push('按节奏改句失败，已保留原建议')
    }
  }

  assist.planEval = evaluation.summary
  assist.planCritique = evaluation.planCritique
  assist.warnings = [...new Set([...assist.warnings, ...warnings])]
  const history = await listPlanEvalRuns(novelId, 30)
  const previous = history.find((run) => run.stage === 'seed-assist' && run.field === field)
  if (previous) assist.previousScore = Math.round(previous.score)
  await savePlanEvalRun({
    novelId,
    stage: 'seed-assist',
    field,
    baseRevision,
    summary: evaluation.summary,
    model: agent.model,
  })
  yield { phase: 'done', message: '建议已生成', assist, warnings: assist.warnings }
}

// ===== 2. 确认立项 → 主线 + 分卷规划 =====

function confirmedSection(confirmed: ConfirmedSeed): string {
  const chars = confirmed.characters
    .map((c) => `- ${c.name}（${c.role === 'protagonist' ? '主角' : c.role === 'antagonist' ? '反派' : '配角'}）：${c.profile}`)
    .join('\n')
  const extra = [
    confirmed.coreConflict?.trim() ? `核心冲突：${confirmed.coreConflict.trim()}` : '',
    confirmed.characterNotes?.trim() ? `角色笔记：\n${confirmed.characterNotes.trim()}` : '',
    confirmed.protagonist?.trim() ? `主角线索：${confirmed.protagonist.trim()}` : '',
    confirmed.worldview?.trim() ? `世界观与设定：${confirmed.worldview.trim()}` : '',
    confirmed.setting?.trim() ? `时代与地点：${confirmed.setting.trim()}` : '',
    confirmed.power?.trim() ? `金手指/核心能力：${confirmed.power.trim()}` : '',
    confirmed.sellingPoints?.trim() ? `卖点与爽点：${confirmed.sellingPoints.trim()}` : '',
    confirmed.tone?.trim() ? `基调与读者：${confirmed.tone.trim()}` : '',
    confirmed.references?.trim() ? `对标作品：${confirmed.references.trim()}` : '',
    confirmed.taboos?.trim() ? `禁忌与雷点：${confirmed.taboos.trim()}` : '',
    confirmed.draft?.trim() ? `作者草稿（零散想法，整理后采纳）：\n${confirmed.draft.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    `书名：《${confirmed.title}》（${confirmed.genre || '未分类'}）\n` +
    `梗概：${confirmed.premise}\n` +
    (chars ? `角色阵容：\n${chars}\n` : '') +
    (extra ? `${extra}\n` : '')
  )
}

export async function* draftMasterPlan(
  novelId: string,
  confirmed: ConfirmedSeed,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent' }
    return
  }
  const styleCtx = await loadPlanningStyleContext(novelId)
  yield { phase: 'llm', message: '正在规划全书主线与分卷…' }
  const volHint = confirmed.volumeCount > 0 ? `全书共 ${confirmed.volumeCount} 卷` : '卷数由你按题材节奏决定（建议3~5卷）'
  const chHint = confirmed.chapterCount && confirmed.chapterCount > 0 ? `全书期望总章数约 ${confirmed.chapterCount} 章` : ''
  const task =
    '你是一名小说大纲架构师。基于以下已确认的立项信息，规划全书主线与分卷。这是写作前的前瞻性规划，不是对已有正文的总结。\n\n' +
    confirmedSection(confirmed) + '\n' +
    `期望：${volHint}${chHint ? '，' + chHint : ''}。\n\n` +
    planningCraftSection(styleCtx, 'master') + '\n\n' +
    '本次要求：\n' +
    '- masterOutline：300~600 字，写核心冲突、关系走向、关键转折与可重复单元；长篇只写“前 30 章确定性 + 之后方向性”，不要过早锁死结局\n' +
    '- 卷与卷之间主线递进、各有职责（开局/推进/转折/收束），卷尾钩子指向下一卷；每卷至少一个可重复单元\n' +
    '- 每卷 estimatedChapters 与 targetWordCount 要互相自洽；给出 targetChapters 时，各卷章数之和必须等于它\n' +
    '- 不写章级事件' +
    notesSection(notes)

  const result = await callPlanLLM(agent, novelId, 'master', task, {
    signal,
    baseRevision: `draft-${Date.now()}`,
  })
  if (signal?.aborted) return
  const plan = parseMasterPlanPayload(result.payload)
  if (!plan) {
    yield { phase: 'error', message: 'AI 输出无法解析为主线规划，请重试' }
    return
  }
  yield { phase: 'done', message: '主线与分卷已生成，可修改后继续', masterPlan: plan, warnings: result.warnings }
}

// ===== 3. 分卷规划 → 章纲骨架 =====

export async function* draftVolumeChapters(
  novelId: string,
  confirmed: ConfirmedSeed,
  masterPlan: MasterPlan,
  volumeIndex: number,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent' }
    return
  }
  const target = masterPlan.volumes[volumeIndex]
  if (!target) {
    yield { phase: 'error', message: '未找到该卷规划' }
    return
  }
  const styleCtx = await loadPlanningStyleContext(novelId)
  yield { phase: 'llm', message: `正在生成《${target.title}》的章纲骨架…` }
  const volsText = masterPlan.volumes
    .map((v, i) => (i === volumeIndex ? `→ 第${i + 1}卷《${v.title}》卷纲：${v.summary}` : `第${i + 1}卷《${v.title}》卷纲：${v.summary}`))
    .join('\n')
  const chHint =
    confirmed.chapterCount && confirmed.chapterCount > 0 && confirmed.volumeCount > 0
      ? `约 ${Math.max(4, Math.round(confirmed.chapterCount / Math.max(1, confirmed.volumeCount)))} 章（按期望总章数均摊）`
      : '由节奏决定（建议8~16章）'

  // 已写章只读：目标卷若已落库，把有正文的章 id 交给契约校验拦截
  const writtenIds: string[] = []
  const existing = await collectVolumes(novelId)
  const targetVol = existing.find((v) => v.vol.order === volumeIndex + 1)
  if (targetVol) {
    for (const ch of targetVol.chapters) {
      if (ch.wordCount > 0 || (await chapterService.loadContent(ch.id)).trim()) writtenIds.push(ch.id)
    }
  }

  const task =
    '你是一名小说大纲架构师。基于立项信息、全书主线与分卷规划，为目标卷生成章纲骨架。\n' +
    '骨架粒度：只出章名 + 一句话骨架（本章发生什么/推进什么/留下什么钩子），写作到该章时再细化，不必写到场景级。\n\n' +
    confirmedSection(confirmed) + '\n' +
    `==== 全书主线 ====\n${masterPlan.masterOutline.slice(0, 4000)}\n\n` +
    `==== 分卷规划 ====\n${volsText}\n\n` +
    `==== 目标卷 ====\n第${volumeIndex + 1}卷《${target.title}》，volumeIndex=${volumeIndex}\n\n` +
    planningCraftSection(styleCtx, 'volume-chapters') + '\n\n' +
    `本次要求：\n` +
    `- 章数：${chHint}\n` +
    '- 每章必须给出目标（hooks）、核心冲突（conflict）、转折/爽点（turn）、落点（payoff）、章末类型（endingType）与目标字数（targetWordCount）\n' +
    '- endingType 只能是：动作 / 台词 / 画面 / 信息 / 未完成动作 / 误会；禁止总结、升华、点题\n' +
    '- 每章至少完成一项：公共事件、关系标签变化、信息揭示、可复用名场面；允许状态维持章，但连续两章不得都是纯过渡\n' +
    '- 每章至少有一个角色做出会改变局面的选择；状态维持章也要有一个暴露性格的小选择\n' +
    '- 首卷前三章额外执行黄金三章检查：第一章立世界/立主角，第二章加深冲突，第三章末留大悬念\n' +
    '- 章名不带「第X章」前缀；同卷章名不得重复；不得为已写章生成骨架' +
    notesSection(notes)

  const result = await callPlanLLM(agent, novelId, 'volume-chapters', task, {
    signal,
    baseRevision: `draft-${Date.now()}`,
    writtenIds,
  })
  if (signal?.aborted) return
  const skeletons = parseChapterSkeletonsPayload(result.payload)
  if (!skeletons) {
    yield { phase: 'error', message: 'AI 输出无法解析为章纲骨架，请重试' }
    return
  }
  const planCritique = critiquePlan(
    skeletons.map((s, i) => ({
      location: `第${i + 1}章《${s.title}》`,
      text: [...s.hooks, s.conflict, s.turn, s.payoff].filter(Boolean).join('；'),
    })),
  )
  yield {
    phase: 'done',
    message: '章纲骨架已生成，可修改后落库',
    chapterSkeletons: skeletons,
    warnings: [...result.warnings, ...planFindingsToWarnings(planCritique.findings)],
  }
}

// ===== 3.5 单章细化：未写章 → 摘要 + 可执行 hooks =====

export async function* draftChapterDetail(
  novelId: string,
  chapterId: string,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  const ch = await chapterService.getById(chapterId)
  if (!ch) {
    yield { phase: 'error', message: '未找到该章' }
    return
  }
  const disk = await chapterService.loadContent(chapterId)
  if (ch.wordCount > 0 || disk.trim()) {
    yield { phase: 'error', message: '该章已有正文，不能再用 AI 生成细纲' }
    return
  }

  yield { phase: 'prepare', message: '正在收集本章上下文…' }
  const [novel, vols, masterOutline] = await Promise.all([
    novelService.getById(novelId),
    collectVolumes(novelId),
    knowledgeService.read(novelId, 'outline.md'),
  ])
  const volume = vols.find((v) => v.vol.id === ch.volumeId)
  const flat = vols.flatMap((v) => v.chapters.map((c) => ({ ch: c, vol: v.vol })))
  const index = flat.findIndex((x) => x.ch.id === chapterId)
  const prev = index > 0 ? flat[index - 1] : null
  const next = index >= 0 && index + 1 < flat.length ? flat[index + 1] : null
  const writtenIds = flat.filter((x) => x.ch.wordCount > 0).map((x) => x.ch.id)

  const styleCtx = await loadPlanningStyleContext(novelId)
  yield { phase: 'llm', message: `正在细化第${ch.order}章《${ch.title}》…` }
  const neighbor = (label: string, x: typeof prev) =>
    x
      ? `- ${label}：第${x.ch.order}章《${x.ch.title}》摘要：${x.ch.summary || '（暂无）'}；细纲：${x.ch.hooks?.length ? x.ch.hooks.join(' / ') : '（暂无）'}\n`
      : ''
  const task =
    '你是一名小说大纲架构师。请把目标章的骨架细化为可直接开写的章细纲。\n' +
    '目标章尚未动笔，只能修改它的规划，不得改动已写章节。\n\n' +
    `==== 作品 ====\n《${novel?.title || '未命名'}》（${novel?.genre?.join('、') || '未分类'}）\n梗概：${novel?.description || '（暂无）'}\n\n` +
    (volume ? `==== 所属卷 ====\n第${volume.vol.order}卷《${volume.vol.title}》卷纲：${volume.vol.summary || '（暂无）'}\n卷目标：${volume.vol.goal || '（暂无）'}\n卷尾钩子：${volume.vol.endingHook || '（暂无）'}\n\n` : '') +
    (masterOutline?.trim() ? `==== 全书大纲节选 ====\n${masterOutline.slice(0, 5000)}\n\n` : '') +
    `==== 目标章 ====\n第${ch.order}章《${ch.title}》\n现有摘要：${ch.summary || '（暂无）'}\n现有细纲：${ch.hooks?.length ? ch.hooks.join(' / ') : '（暂无）'}\n目标字数：${ch.targetWordCount || 3000}\n\n` +
    (prev || next ? `==== 相邻章 ====\n${neighbor('上一章', prev)}${neighbor('下一章', next)}\n` : '') +
    planningCraftSection(styleCtx, 'chapter-detail') + '\n\n' +
    '本次要求：\n' +
    '- summary：1~3 句，说清本章发生了什么、关系标签怎么变、读者多知道了什么\n' +
    '- hooks：3~6 条可执行事件（谁在哪做什么、冲突如何升级、结尾留什么钩子），不要写抽象主题\n' +
    '- 每条 hook 尽量写成一个角色做的动作或选择，而不是「发生冲突」「关系升温」这类事件类别\n' +
    '- 最后一条 hooks 必须是章末画面/动作/台词/信息/未完成动作/误会，不能是总结或升华\n' +
    '- targetWordCount：500~20000 的整数，与本章信息量匹配\n' +
    '- continuityNotes：写明承接上一章的哪条线、为下一章留下什么（可为空数组）' +
    notesSection(notes)

  const result = await callPlanLLM(agent, novelId, 'chapter-detail', task, {
    signal,
    baseRevision: `draft-${Date.now()}`,
    writtenIds,
  })
  if (signal?.aborted) return
  const detail = parseChapterDetailPayload(result.payload)
  if (!detail) {
    yield { phase: 'error', message: 'AI 输出无法解析为章细纲，请重试' }
    return
  }
  const hookPlan = critiquePlan(
    detail.hooks.map((hook, i) => ({ location: `第${ch.order}章 hook ${i + 1}`, text: hook })),
  )
  detail.warnings = [...result.warnings, ...planFindingsToWarnings(hookPlan.findings)]
  yield { phase: 'done', message: '章细纲已生成，请确认后采纳', chapterDetail: detail, warnings: detail.warnings }
}

/** 采纳章细纲：只回写未写章；已写章（字数>0 或磁盘有正文）再次复核并拒绝 */
export async function applyChapterDetail(chapterId: string, detail: ChapterDetailProposal): Promise<boolean> {
  const ch = await chapterService.getById(chapterId)
  if (!ch || ch.wordCount > 0) return false
  const disk = await chapterService.loadContent(chapterId)
  if (disk && disk.trim()) return false
  await chapterService.update(chapterId, {
    summary: detail.summary,
    hooks: detail.hooks.map(String),
    targetWordCount: detail.targetWordCount,
  })
  return true
}

// ===== 3.6 采纳立项提案 / 卷章纲骨架 =====

export interface SeedApplyInput {
  title: string
  genre: string
  premise: string
  characters: ProposedCharacter[]
  /** 作者手写的世界观设定（多行，「标题：内容」优先） */
  worldview?: string
  /** 基调与目标读者 */
  tone?: string
  /** 时代与地点 */
  setting?: string
  /** 金手指 / 力量体系 */
  power?: string
  /** AI 提案给出的世界铁律 */
  worldAnchors?: string[]
}

export interface SeedWorldviewEntry {
  title: string
  content: string
}

/** 把多行世界观文本拆成可入库条目；「标题：内容」优先，否则整行作内容 */
export function seedWorldviewEntries(input: {
  worldview?: string
  tone?: string
  setting?: string
  power?: string
  worldAnchors?: string[]
}): SeedWorldviewEntry[] {
  const out: SeedWorldviewEntry[] = []
  const seen = new Set<string>()
  const push = (title: string, content: string) => {
    const t = title.trim().slice(0, 20)
    const c = content.trim()
    if (!t || !c || seen.has(t)) return
    seen.add(t)
    out.push({ title: t, content: c })
  }
  const addLine = (line: string) => {
    const cleaned = line.replace(/^[-*•·\s]+/, '').trim()
    if (!cleaned) return
    const m = cleaned.match(/^([^：:]{1,20})[：:]\s*(.+)$/)
    if (m) push(m[1], m[2])
    else push(cleaned, cleaned)
  }
  for (const line of (input.worldview ?? '').split(/\r?\n/)) addLine(line)
  for (const line of (input.setting ?? '').split(/\r?\n/)) addLine(line)
  for (const line of (input.power ?? '').split(/\r?\n/)) addLine(line)
  for (const anchor of input.worldAnchors ?? []) addLine(String(anchor))
  if (input.tone?.trim()) push('基调与读者', input.tone)
  return out
}

/** 世界观条目只增不改：同名（按标题）已存在时跳过，避免覆盖作者手改 */
async function persistSeedWorldviews(
  novelId: string,
  input: { worldview?: string; tone?: string; setting?: string; power?: string; worldAnchors?: string[] },
): Promise<number> {
  const entries = seedWorldviewEntries(input)
  if (entries.length === 0) return 0
  try {
    const existing = await worldviewService.getByNovelId(novelId)
    const titles = new Set(existing.map((w) => w.title.trim()))
    let created = 0
    for (const entry of entries) {
      if (titles.has(entry.title)) continue
      titles.add(entry.title)
      await worldviewService.create({
        novelId,
        category: 'other',
        title: entry.title,
        content: entry.content,
      })
      created++
    }
    return created
  } catch (e) {
    console.warn('[persistSeedWorldviews] failed:', e)
    return 0
  }
}

/** 采纳立项提案：写入书名/类型/梗概，角色按重名跳过，绝不覆盖已有角色 */
export async function applySeedProposal(
  novelId: string,
  input: SeedApplyInput,
): Promise<{ title: boolean; genre: boolean; description: boolean; characters: number; worldviews: number }> {
  const novel = await novelService.getById(novelId)
  if (!novel) throw new Error('未找到该小说')
  const patch: Partial<Novel> = {}
  let title = false
  let genre = false
  let description = false
  const nextTitle = input.title.trim()
  if (nextTitle && nextTitle !== novel.title) {
    patch.title = nextTitle
    title = true
  }
  const nextGenre = input.genre.trim()
  if (nextGenre && !novel.genre.includes(nextGenre)) {
    patch.genre = [...novel.genre, nextGenre]
    genre = true
  }
  const nextPremise = input.premise.trim()
  if (nextPremise && nextPremise !== novel.description) {
    patch.description = nextPremise
    description = true
  }
  if (Object.keys(patch).length > 0) await novelService.update(novelId, patch)

  let characters = 0
  const existing = await characterService.getByNovelId(novelId)
  for (const pc of input.characters) {
    const name = pc.name.trim()
    if (!name || existing.some((c) => c.name === name)) continue
    await characterService.create({
      id: crypto.randomUUID(),
      novelId,
      name,
      role: pc.role,
      profile: pc.profile,
      dynamicState: '',
    })
    characters++
  }
  if (characters > 0) {
    try {
      await knowledgeService.syncCharacters(novelId)
    } catch (e) {
      console.warn('[applySeedProposal] sync characters failed:', e)
    }
  }
  const worldviews = await persistSeedWorldviews(novelId, input)
  try {
    await knowledgeService.syncOutline(novelId)
  } catch (e) {
    console.warn('[applySeedProposal] sync outline failed:', e)
  }
  return { title, genre, description, characters, worldviews }
}

/** 采纳卷章纲：把骨架追加为未写章；只新增，绝不改动已写章 */
export async function applyVolumeChapters(
  novelId: string,
  volumeId: string,
  skeletons: ChapterSkeleton[],
): Promise<number> {
  const existing = await chapterService.getByVolumeId(volumeId)
  let nextOrder = existing.reduce((m, c) => Math.max(m, c.order || 0), 0)
  let created = 0
  for (const skeleton of skeletons) {
    const title = skeleton.title?.trim()
    if (!title) continue
    const hooks = (skeleton.hooks ?? []).map(String).map((h) => h.trim()).filter(Boolean)
    if (hooks.length === 0) continue
    nextOrder++
    const now = new Date().toISOString()
    await chapterService.create({
      id: crypto.randomUUID(),
      volumeId,
      title,
      order: nextOrder,
      contentPath: `content/${novelId}/${crypto.randomUUID()}.md`,
      wordCount: 0,
      status: 'draft',
      targetWordCount:
        typeof skeleton.targetWordCount === 'number' &&
        skeleton.targetWordCount >= 500 &&
        skeleton.targetWordCount <= 20000
          ? skeleton.targetWordCount
          : 3000,
      hooks,
      summary: '',
      createdAt: now,
      updatedAt: now,
    })
    created++
  }
  if (created > 0) {
    try {
      await knowledgeService.syncOutline(novelId)
    } catch (e) {
      console.warn('[applyVolumeChapters] sync outline failed:', e)
    }
  }
  return created
}

// ===== 4. 落库：立项信息 + 卷 + 首卷章骨架 + 角色 + KB outline.md =====

export interface ApplyOutlineInput {
  confirmed: ConfirmedSeed
  masterPlan: MasterPlan
  firstVolumeChapters: ChapterSkeleton[]
}

export async function applyProspectiveOutline(
  novelId: string,
  input: ApplyOutlineInput,
): Promise<{ volumes: number; chapters: number; characters: number }> {
  const { confirmed, masterPlan, firstVolumeChapters } = input

  // 1. 更新小说立项信息（有变化才写）
  const novel = await novelService.getById(novelId)
  if (novel) {
    const patch: Partial<Novel> = {}
    if (confirmed.title && confirmed.title !== novel.title) patch.title = confirmed.title
    if (confirmed.genre && !novel.genre.includes(confirmed.genre)) patch.genre = [...novel.genre, confirmed.genre]
    if (confirmed.premise && confirmed.premise !== novel.description) patch.description = confirmed.premise
    if (Object.keys(patch).length > 0) await novelService.update(novelId, patch)
  }

  // 2. 建卷（追加在已有卷之后）
  const existingVols = await volumeService.getByNovelId(novelId)
  let baseOrder = existingVols.reduce((m, v) => Math.max(m, v.order || 0), 0)
  const createdVolIds: string[] = []
  for (const vp of masterPlan.volumes) {
    baseOrder++
    const id = crypto.randomUUID()
    await volumeService.create({
      id,
      novelId,
      title: vp.title,
      order: baseOrder,
      summary: vp.summary,
      goal: vp.goal,
      climax: vp.climax,
      endingHook: vp.endingHook,
      estimatedChapters: vp.estimatedChapters,
      targetWordCount: vp.targetWordCount,
    })
    createdVolIds.push(id)
  }

  // 3. 首个新卷建章（骨架 hooks，空正文）
  let chapterCount = 0
  if (createdVolIds[0]) {
    for (let i = 0; i < firstVolumeChapters.length; i++) {
      const c = firstVolumeChapters[i]
      await chapterService.create({
        id: crypto.randomUUID(),
        volumeId: createdVolIds[0],
        title: c.title,
        order: i + 1,
        contentPath: `content/${novelId}/${crypto.randomUUID()}.md`,
        wordCount: 0,
        status: 'draft',
        targetWordCount:
          typeof c.targetWordCount === 'number' && c.targetWordCount >= 500 && c.targetWordCount <= 20000
            ? c.targetWordCount
            : 3000,
        hooks: c.hooks.map(String),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      chapterCount++
    }
  }

  // 4. 角色（确认制）：与已有角色重名的跳过，绝不覆盖
  let charCount = 0
  const existingChars = await characterService.getByNovelId(novelId)
  for (const pc of confirmed.characters) {
    if (existingChars.some((c) => c.name === pc.name)) continue
    await characterService.create({
      id: crypto.randomUUID(),
      novelId,
      name: pc.name,
      role: pc.role,
      profile: pc.profile,
      dynamicState: '',
    })
    charCount++
  }

  // 4.5 世界观条目（只增不改）：立项时填写的世界设定与基调长期留存
  await persistSeedWorldviews(novelId, {
    worldview: confirmed.worldview,
    tone: confirmed.tone,
    setting: confirmed.setting,
    power: confirmed.power,
  })

  // 5. KB outline.md（prose 版）。不调 syncOutline——它会用 DB 骨架覆写 prose 版大纲
  const md = buildProspectiveOutlineMd(confirmed, masterPlan, firstVolumeChapters)
  await knowledgeService.write(novelId, 'outline.md', md, 'outline-planner')

  return { volumes: createdVolIds.length, chapters: chapterCount, characters: charCount }
}

// ===== 5. 重订走向：已写事实 + 现有规划 → 新旧走向对照 =====

export async function* calibrateOutline(
  novelId: string,
  userNotes?: string,
  signal?: AbortSignal,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  yield { phase: 'prepare', message: '正在盘点已写内容与未写规划…' }
  const vols = await collectVolumes(novelId)
  const allChapters = vols.flatMap((v) => v.chapters)

  // 预载磁盘正文，二分已写/未写
  const contents: Record<string, string> = {}
  for (const ch of allChapters) {
    if (ch.wordCount > 0) continue // 已确定是已写章，无需读盘
    contents[ch.id] = await chapterService.loadContent(ch.id)
  }
  const { written, unwritten } = splitWrittenUnwritten(allChapters, contents)
  if (unwritten.length === 0) {
    yield { phase: 'error', message: '没有未写的章节，无需重订走向' }
    return
  }
  const writtenSet = new Set(written.map((c) => c.id))

  // 已写内容（事实）：卷纲 + 章摘要/正文节选
  const writtenText: string[] = []
  for (const { vol, chapters } of vols) {
    const writtenInVol = chapters.filter((c) => writtenSet.has(c.id))
    if (writtenInVol.length === 0) continue
    writtenText.push(`## 第${vol.order}卷《${vol.title}》卷纲：${vol.summary || '（暂无）'}`)
    for (const c of writtenInVol) {
      writtenText.push(`- 第${c.order}章《${c.title}》：${(await getChapterDigest(c)).slice(0, 500)}`)
    }
  }

  // 未写章（当前规划）
  const unwrittenMap = new Map<
    string,
    { volumeId: string; volumeOrder: number; chapterOrder: number; chapterTitle: string; oldHooks: string[] }
  >()
  const unwrittenText: string[] = []
  for (const { vol, chapters } of vols) {
    for (const c of chapters) {
      if (writtenSet.has(c.id)) continue
      const hooks = (c.hooks ?? []).map(String)
      unwrittenMap.set(c.id, {
        volumeId: vol.id,
        volumeOrder: vol.order,
        chapterOrder: c.order,
        chapterTitle: c.title,
        oldHooks: hooks,
      })
      unwrittenText.push(`- 第${c.order}章《${c.title}》（id: ${c.id}）当前细纲：${hooks.length ? hooks.join(' / ') : '（暂无）'}`)
    }
  }

  const fullOutline = (await knowledgeService.read(novelId, 'outline.md')) ?? ''

  yield { phase: 'llm', message: '正在比对已写事实与后续走向…' }
  const task =
    '你是一名小说大纲架构师，执行「重订走向」校准。\n' +
    '背景：作者已写完部分章节，正文实际走向可能已偏离原大纲（或作者中途修改了已写内容）。' +
    '请以已写内容为事实基准，重订所有未写章的走向：只调整确需变化的章，与已写事实一致的章保持原样。\n\n' +
    `==== 已写内容（事实，不可更改）====\n${writtenText.join('\n').slice(0, 14000)}\n\n` +
    `==== 未写章（当前规划，待校准）====\n${unwrittenText.join('\n').slice(0, 8000)}\n\n` +
    (fullOutline.trim() ? `==== 全书大纲（现状）====\n${fullOutline.slice(0, 6000)}\n\n` : '') +
    (userNotes?.trim() ? `==== 作者说明（作者主动给出的变更/要求）====\n${userNotes.trim().slice(0, 2000)}\n\n` : '') +
    '本次要求：\n' +
    '- 只对确需调整的未写章输出 diffs，无需调整的章不要输出\n' +
    '- chapterId 必须原样使用上面给出的 id；oldHooks 填该章当前细纲\n' +
    '- newHooks 不得与已写内容矛盾；未写章旧细纲与已写事实冲突的必须给出修正\n' +
    '- 若作者说明与已写事实冲突，以作者说明为新的创作意图，并让后续章节承接它\n' +
    '- 不得出现已写章的 id；不得修改书名、简介、主线与卷纲'

  const result = await callPlanLLM(agent, novelId, 'calibrate', task, {
    signal,
    baseRevision: `draft-${Date.now()}`,
    writtenIds: [...writtenSet],
  })
  if (signal?.aborted) return
  const diff = parseRecalibrateDiffPayload(result.payload, unwrittenMap)
  if (!diff) {
    yield { phase: 'error', message: 'AI 输出无法解析为校准方案，请重试' }
    return
  }
  yield { phase: 'done', message: '校准完成，请审阅新旧走向', diff, warnings: result.warnings }
}

/**
 * 采纳校准：回写未写章 hooks。
 * 硬红线落库前复核：wordCount>0 或磁盘有正文的章绝不更新。
 * 不调 syncOutline——prose 版 outline.md 的主线/卷纲不受 hooks 变更影响，
 * 且 syncOutline 会用 DB 骨架覆写 prose 版大纲。
 */
export async function applyCalibration(accepted: RecalibrateDiffItem[]): Promise<number> {
  let applied = 0
  for (const item of accepted) {
    const ch = await chapterService.getById(item.chapterId)
    if (!ch) continue
    // 红线复核：已写章绝不回写
    if (ch.wordCount > 0) continue
    const disk = await chapterService.loadContent(ch.id)
    if (disk && disk.trim()) continue
    await chapterService.update(ch.id, { hooks: item.newHooks.map(String) })
    applied++
  }
  return applied
}

// ===== 6. 大纲体检：确定性脚本 + AI 审阅 =====

/** 卷序/章序（均 0 起）→ 章 id，用于体检补丁定位 */
function reviewResolver(vols: VolChap[]) {
  return (volumeOrder?: number, chapterOrder?: number): string | undefined => {
    if (volumeOrder == null || chapterOrder == null) return undefined
    return vols[volumeOrder]?.chapters[chapterOrder]?.id
  }
}

function buildHealthSnapshot(vols: VolChap[]) {
  return {
    volumes: vols.map(({ vol, chapters }) => ({
      title: vol.title,
      summary: vol.summary,
      goal: vol.goal,
      climax: vol.climax,
      endingHook: vol.endingHook,
      estimatedChapters: vol.estimatedChapters || chapters.length,
      targetWordCount: vol.targetWordCount || chapters.reduce((sum, c) => sum + (c.targetWordCount || 0), 0),
      chapters: chapters.map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary ?? '',
        hooks: c.hooks ?? [],
        targetWordCount: c.targetWordCount,
        wordCount: c.wordCount,
      })),
    })),
  }
}

/** 调主进程跑 check-plan-health.js；无 Electron 环境或脚本不可用时返回 null，由 UI 提示跳过 */
async function runPlanHealth(
  vols: VolChap[],
  writtenIds: string[],
): Promise<{ severity: OutlineIssueSeverity; type: string; location: string; message: string }[] | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.plan : undefined
  if (!api?.health) return null
  try {
    const res = (await api.health({ plan: buildHealthSnapshot(vols), writtenIds })) as {
      findings?: { severity?: string; type?: string; location?: string; message?: string }[]
    } | null
    if (!res || !Array.isArray(res.findings)) return null
    return res.findings
      .filter((f) => f && typeof f.message === 'string')
      .map((f) => ({
        severity: f.severity === 'blocking' || f.severity === 'warning' ? f.severity : ('info' as OutlineIssueSeverity),
        type: typeof f.type === 'string' ? f.type : 'structure',
        location: typeof f.location === 'string' ? f.location : '',
        message: f.message as string,
      }))
  } catch (e) {
    console.warn('[reviewOutline] 体检脚本不可用，跳过确定性检查:', e)
    return null
  }
}

export async function* reviewOutline(
  novelId: string,
  signal?: AbortSignal,
  notes?: string,
): AsyncGenerator<PlannerProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  yield { phase: 'prepare', message: '正在收集大纲与已写内容…' }
  const vols = await collectVolumes(novelId)
  if (vols.length === 0) {
    yield { phase: 'error', message: '还没有大纲，请先完成分卷规划' }
    return
  }
  const allChapters = vols.flatMap((v) => v.chapters)
  const contents: Record<string, string> = {}
  for (const ch of allChapters) {
    if (ch.wordCount > 0) continue
    contents[ch.id] = await chapterService.loadContent(ch.id)
  }
  const { written } = splitWrittenUnwritten(allChapters, contents)
  const writtenIds = written.map((c) => c.id)
  const writtenSet = new Set(writtenIds)

  yield { phase: 'prepare', message: '正在运行结构体检…' }
  const deterministic = await runPlanHealth(vols, writtenIds)

  const outlineText: string[] = []
  vols.forEach(({ vol, chapters }, vi) => {
    outlineText.push(
      `## 第${vi + 1}卷《${vol.title}》\n卷纲：${vol.summary || '（暂无）'}｜卷目标：${vol.goal || '（暂无）'}｜卷末高潮：${vol.climax || '（暂无）'}｜卷尾钩子：${vol.endingHook || '（暂无）'}`,
    )
    chapters.forEach((c, ci) => {
      outlineText.push(
        `- 第${vi + 1}卷第${ci + 1}章《${c.title}》（volumeOrder=${vi}, chapterOrder=${ci}${writtenSet.has(c.id) ? '，已写' : ''}）` +
          ` 摘要：${c.summary || '（暂无）'}；细纲：${c.hooks?.length ? c.hooks.join(' / ') : '（暂无）'}；目标字数：${c.targetWordCount || '（未设）'}`,
      )
    })
  })

  yield { phase: 'llm', message: '正在审阅大纲结构、节奏与连贯性…' }
  const task =
    '你是一名小说大纲审稿人。请审阅以下规划大纲，找出会导致写作卡壳或读者流失的问题。\n' +
    `全书共 ${vols.length} 卷、${allChapters.length} 章，其中已写 ${writtenIds.length} 章。已写章只读，不得提出修改其摘要/hooks 的补丁。\n\n` +
    `==== 规划大纲 ====\n${outlineText.join('\n').slice(0, 16000)}\n\n` +
    (deterministic
      ? `==== 结构体检（确定性，无需重复报告）====\n${
          deterministic.length
            ? deterministic.map((f) => `- [${f.severity}] ${f.location}：${f.message}`).join('\n')
            : '（无结构性问题）'
        }\n\n`
      : '') +
    '本次要求：\n' +
    '- score：0~100，综合节奏、逻辑、动机、重复、铺垫回收、钩子密度与卷间升级\n' +
    '- issues：只报会实际影响写作的问题，按严重度排序；不要与结构体检重复\n' +
    '- severity 只能是 blocking/warning/info；type 只能是 pacing/logic/motivation/repetition/setup-payoff/hook-density/volume-escalation\n' +
    '- volumeOrder/chapterOrder 从 0 开始，对应上面的标注；chapterId 可省略\n' +
    '- patch 可选，只能指向未写章，且只允许 summary 与 hooks；已写章不得出现在 patch 中\n' +
    '- summary：一段话结论，指出最该先改的 1~2 处' +
    notesSection(notes)

  const result = await callPlanLLM(agent, novelId, 'review', task, {
    signal,
    baseRevision: `draft-${Date.now()}`,
    writtenIds,
  })
  if (signal?.aborted) return
  const review = parseOutlineReviewPayload(result.payload, {
    writtenIds: writtenSet,
    resolveChapterId: reviewResolver(vols),
  })
  if (!review) {
    yield { phase: 'error', message: 'AI 输出无法解析为体检结果，请重试' }
    return
  }
  review.deterministic = deterministic ?? undefined
  review.warnings = result.warnings
  yield { phase: 'done', message: '体检完成，请逐条处理或采纳补丁', review, warnings: result.warnings }
}

/** 采纳体检补丁：只回写未写章的摘要/hooks；落库前再次复核已写红线 */
export async function applyReviewPatches(issues: OutlineReviewIssue[], vols: VolChap[]): Promise<number> {
  const resolve = reviewResolver(vols)
  let applied = 0
  for (const issue of issues) {
    if (!issue.patch) continue
    const chapterId = issue.chapterId ?? resolve(issue.volumeOrder, issue.chapterOrder)
    if (!chapterId) continue
    const ch = await chapterService.getById(chapterId)
    if (!ch || ch.wordCount > 0) continue
    const disk = await chapterService.loadContent(chapterId)
    if (disk && disk.trim()) continue
    const patch: { summary?: string; hooks?: string[] } = {}
    if (issue.patch.summary) patch.summary = issue.patch.summary
    if (issue.patch.hooks?.length) patch.hooks = issue.patch.hooks.map(String)
    if (Object.keys(patch).length === 0) continue
    await chapterService.update(chapterId, patch)
    applied++
  }
  return applied
}
