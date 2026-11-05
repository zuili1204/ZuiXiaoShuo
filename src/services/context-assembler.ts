/**
 * 上下文装配器（文档 M1 核心修复 / G1）。
 *
 * 旧实现 buildAgentContext 只注入了"当前章节正文 + 一句概要 + 空 RAG + 空伏笔视图"，
 * 完全漏掉了：书名/题材/卷大纲/章节细纲(hooks)/角色档案/世界观/前章正文/追踪状态全量/时间线。
 * 本模块一次性把"写作所需的全部资料"装配成 ContextBundle，并格式化为可注入 system prompt 的文本。
 */
import type {
  BuildContextOptions,
  Chapter,
  ContextBundle,
  ContextPlan,
  ContextPlanOverrides,
  ContextSection,
  ContextSectionKey,
  ContextSummary,
  ContextTask,
  Novel,
  Volume,
  Character,
  Worldview,
  Force,
  SceneCard,
} from '@shared/types'

const api = () => window.electronAPI
import {
  novelService,
  volumeService,
  chapterService,
  characterService,
  worldviewService,
  forceService,
} from './data-service'
import { loadTrackingState, generateForeshadowView, generateStateCard } from './tracking-service'
import {
  buildStoryStateBrief,
  listCharacterStates,
  listPlotThreads,
  listTimelineEvents,
} from './story-state-service'
import { loadIndex, search, buildContextString, indexNovelAssets, getChunks } from './rag-service'
import { knowledgeService } from './knowledge-service'
import { listSceneCards } from './scene-service'
import { loadMergedStyleForNovel } from './style-blend-service'
import { renderStylePrompt } from './style-prompt-service'
import { getSetting, setSetting } from './settings-service'
import { ActionLog } from './log-service'

function parseGenre(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    /* not json */
  }
  return [raw]
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    console.error('[context-assembler] safe() caught:', e)
    return fallback
  }
}

// ===== token 估算与预算裁剪 =====

/**
 * 保守 token 估算：中文 1 字 ≈ 1.5 token，英文/ASCII 约 4 字符 ≈ 1 token。
 * 宁可少装，不可超窗；后续可接真实 tokenizer 校准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) ascii++
    else if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) cjk++
    else other++
  }
  return Math.ceil(cjk * 1.5 + ascii / 4 + other * 1.5)
}

function truncateToTokens(
  text: string,
  maxTokens: number,
  keep: 'head' | 'tail'
): { text: string; tokens: number } {
  if (!text || maxTokens <= 0) return { text: '', tokens: 0 }
  const total = estimateTokens(text)
  if (total <= maxTokens) return { text, tokens: total }

  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const slice = keep === 'tail' ? text.slice(-mid) : text.slice(0, mid)
    if (estimateTokens(slice) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  const slice = lo > 0 ? (keep === 'tail' ? text.slice(-lo) : text.slice(0, lo)) : ''
  return { text: slice, tokens: estimateTokens(slice) }
}

export const CONTEXT_SECTION_LABELS: Record<ContextSectionKey, string> = {
  safety: '安全与系统约束',
  canon: '作品事实（大纲 / 设定 / 角色）',
  scene: '本章场景卡',
  current: '当前章节',
  previous: '上一章',
  state: '创作状态与伏笔',
  rag: '资料检索与导航',
  style: '文风参考',
  history: '历史对话',
}

const SECTION_PRIORITY: Record<ContextSectionKey, number> = {
  safety: 1,
  canon: 2,
  state: 3,
  scene: 4,
  current: 5,
  previous: 6,
  rag: 7,
  style: 8,
  history: 9,
}

const VALID_SECTION_KEYS = new Set<ContextSectionKey>(Object.keys(SECTION_PRIORITY) as ContextSectionKey[])

function contextOverridesKey(novelId: string): string {
  return `novel:${novelId}:contextPlanOverrides`
}

/** 读取本书已保存的上下文固定/排除偏好。 */
export async function loadContextPlanOverrides(novelId: string): Promise<ContextPlanOverrides> {
  const raw = await getSetting<string>(contextOverridesKey(novelId), '')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return sanitizeOverrides(parsed)
  } catch {
    return {}
  }
}

/** 保存上下文固定/排除偏好（按书生效）。 */
export async function saveContextPlanOverrides(
  novelId: string,
  overrides: ContextPlanOverrides
): Promise<void> {
  await setSetting(contextOverridesKey(novelId), JSON.stringify(sanitizeOverrides(overrides)))
}

function sanitizeOverrides(input: unknown): ContextPlanOverrides {
  const out: ContextPlanOverrides = {}
  if (!input || typeof input !== 'object') return out
  const row = input as { pin?: unknown; exclude?: unknown }
  const pick = (v: unknown): ContextSectionKey[] => {
    if (!Array.isArray(v)) return []
    const keys = v.filter((k): k is ContextSectionKey => typeof k === 'string' && VALID_SECTION_KEYS.has(k as ContextSectionKey))
    return Array.from(new Set(keys)).filter((k) => k !== 'safety')
  }
  const pin = pick(row.pin)
  const exclude = pick(row.exclude)
  if (pin.length) out.pin = pin
  if (exclude.length) out.exclude = exclude.filter((k) => !pin.includes(k))
  return out
}

async function resolveNovelId(o: BuildContextOptions): Promise<string | undefined> {
  if (o.novelId) return o.novelId
  const vid = o.volumeId ?? o.chapter?.volumeId
  if (vid) {
    try {
      const rows = (await api().db.query('SELECT novel_id FROM volumes WHERE id = ?', [vid])) as any[]
      if (rows[0]?.novel_id) return rows[0].novel_id
    } catch {
      /* ignore */
    }
  }
  return undefined
}

async function readChapterContent(chapter: Chapter): Promise<string | undefined> {
  if (!chapter.contentPath) return undefined
  try {
    const exists = await api().file.exists(chapter.contentPath)
    if (!exists) return undefined
    return await api().file.read(chapter.contentPath)
  } catch {
    return undefined
  }
}

function buildOutlineText(
  volumeChapters: { volume: Volume; chapters: Chapter[] }[],
  currentChapterId?: string,
): string {
  // 2026-10-05 事故修复：旧版把全书所有章的摘要+hooks 无差别注入，
  // 导致 ①当前章旧稿摘要（废弃版本剧情）被当作既定事实喂给 writer；
  // ②未来章的旧版规划摘要剧透污染本次走向。改为三分区注入。
  const flat = volumeChapters.flatMap((vc) => vc.chapters)
  const curIdx = currentChapterId ? flat.findIndex((c) => c.id === currentChapterId) : -1

  const parts: string[] = []
  for (const { volume, chapters } of volumeChapters) {
    parts.push(`【卷】${volume.title}（${volume.summary || '暂无卷纲'}）`)
    for (const c of chapters) {
      const isCurrent = curIdx >= 0 && flat[curIdx]?.id === c.id
      const isWritten = (c.wordCount ?? 0) > 0 || !!c.contentPath
      if (isCurrent) {
        // 当前章：只注入 hooks（本次写作的锚点依据），旧摘要不得注入
        parts.push(`  - 第${c.order}章 《${c.title}》  ◀ 当前章节（写作目标）`)
        if (c.hooks?.length) parts.push(`      细纲(hooks，必须逐条覆盖): ${c.hooks.join(' / ')}`)
        else parts.push('      （本章暂无细纲，请严格按作者指令写作）')
      } else if (isWritten) {
        // 已写章：摘要+hooks 都是前情回顾
        parts.push(`  - 第${c.order}章 《${c.title}》（已写）`)
        if (c.summary) parts.push(`      摘要: ${c.summary}`)
        if (c.hooks?.length) parts.push(`      细纲(hooks): ${c.hooks.join(' / ')}`)
      } else {
        // 未写章：只注入规划 hooks，不注入摘要（防废弃版本剧透）
        parts.push(`  - 第${c.order}章 《${c.title}》（未写）`)
        if (c.hooks?.length) parts.push(`      规划细纲(hooks): ${c.hooks.join(' / ')}`)
      }
    }
  }
  return parts.join('\n')
}

function formatCharacter(c: Character): string {
  const lines = [`角色：${c.name}（${c.role}）`]
  if (c.gender) lines.push(`性别：${c.gender}`)
  if (c.age) lines.push(`年龄：${c.age}`)
  if (c.personality) lines.push(`性格：${c.personality}`)
  if (c.appearance) lines.push(`外貌：${c.appearance}`)
  if (c.profile) lines.push(`简介：${c.profile}`)
  if (c.dynamicState) lines.push(`当前状态：${c.dynamicState}`)
  return lines.join('\n')
}

/** 装配一次写作所需的完整上下文。 */
export async function assembleContext(options: BuildContextOptions): Promise<ContextBundle> {
  const novelId = await resolveNovelId(options)
  if (!novelId) {
    // 无小说上下文：返回最小结构，避免注入崩溃
    return {
      novelId: '',
      summary: {
        novelTitle: '未命名',
        genre: [],
        totalChapters: 0,
        totalWordCount: 0,
        committedChapters: 0,
        activeForeshadowings: 0,
        characters: 0,
      },
      novel: { title: '', description: '', genre: [], targetPlatform: '' },
      outline: '',
      characters: [],
      charactersText: '',
      worldviews: [],
      worldviewsText: '',
      forces: [],
      forcesText: '',
      foreshadowView: '',
      trackingStateCard: '',
      sceneCards: [],
      ragContext: '',
      navigationContext: '',
      adjacentChapters: {},
      previousMessages: options.previousMessages,
    }
  }

  // 1. 小说基础
  const novel = await safe(() => novelService.getById(novelId) as Promise<Novel | null>, null)
  const genre = parseGenre(novel?.genre)

  // 2. 大纲（卷 + 章节）
  const volumes = await safe(() => volumeService.getByNovelId(novelId) as Promise<Volume[]>, [] as Volume[])
  const volumeChapters: { volume: Volume; chapters: Chapter[] }[] = []
  let totalWordCount = 0
  for (const v of volumes) {
    const chs = await safe(() => chapterService.getByVolumeId(v.id) as Promise<Chapter[]>, [] as Chapter[])
    volumeChapters.push({ volume: v, chapters: chs })
    for (const c of chs) totalWordCount += c.wordCount ?? 0
  }
  const totalChapters = volumeChapters.reduce((s, vc) => s + vc.chapters.length, 0)
  const outline = buildOutlineText(volumeChapters, options.chapter?.id ?? options.chapterId)

  // 3. 当前章节（含正文）
  let currentChapterFull: Chapter | undefined
  if (options.chapter) currentChapterFull = options.chapter
  else if (options.chapterId) currentChapterFull = await safe(() => chapterService.getById(options.chapterId!) as Promise<Chapter | undefined>, undefined)
  let currentChapter: ContextBundle['currentChapter'] | undefined
  if (currentChapterFull) {
    // excludeCurrentChapterContent：重新生成时排除本章旧稿（编辑器内容/磁盘正文都不进上下文）
    const content = options.excludeCurrentChapterContent
      ? undefined
      : (options.chapterContent ?? (await safe(() => readChapterContent(currentChapterFull), undefined)))
    currentChapter = {
      title: currentChapterFull.title,
      order: currentChapterFull.order,
      // excludeCurrentChapterContent（重生成模式）：旧摘要同样不得注入——
      // 渲染端会输出「本章摘要」，废弃版本的剧情会被 writer 当既定事实（2026-10-05 事故）
      summary: options.excludeCurrentChapterContent ? undefined : currentChapterFull.summary,
      hooks: currentChapterFull.hooks ?? [],
      content,
    }
  }

  // 4. 场景卡（施工图）：本章逐场写作/改写的执行依据
  const sceneCards = currentChapterFull
    ? await safe(() => listSceneCards(currentChapterFull.id), [] as SceneCard[])
    : []

  // 5. 前后章（续写 / 上下文承接）
  const flat: Chapter[] = volumeChapters.flatMap((vc) => vc.chapters)
  const idx = flat.findIndex((c) => c.id === currentChapterFull?.id)
  const prev = idx > 0 ? flat[idx - 1] : undefined
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : undefined
  const adjacentChapters: ContextBundle['adjacentChapters'] = {
    prev: prev
      ? {
          title: prev.title,
          order: prev.order,
          summary: prev.summary,
          content: await safe(() => readChapterContent(prev), undefined),
        }
      : undefined,
    // 下一章不注入 summary：未来章摘要多为旧版规划文本，会剧透污染本次走向；
    // 只给规划 hooks（前瞻锚点）
    next: next ? { title: next.title, order: next.order, hooks: next.hooks ?? [] } : undefined,
  }
  const volumeTitle = currentChapterFull
    ? volumeChapters.find((vc) => vc.chapters.some((c) => c.id === currentChapterFull!.id))?.volume.title
    : undefined

  // 5. 角色档案
  const characters = await safe(() => characterService.getByNovelId(novelId) as Promise<Character[]>, [] as Character[])
  const charactersText = characters.map(formatCharacter).join('\n\n')

  // 6. 世界观
  const worldviews = await safe(() => worldviewService.getByNovelId(novelId) as Promise<Worldview[]>, [] as Worldview[])
  const worldviewsText = worldviews
    .map((w) => `【${w.title}】(${w.category})\n${w.content}`)
    .join('\n\n')

  // 6.1 势力
  const forces = await safe(() => forceService.getByNovelId(novelId) as Promise<Force[]>, [] as Force[])
  const forcesText = forces
    .map((f) => {
      const parts = [`【${f.name}】(${f.type})`]
      if (f.level) parts.push(`等级：${f.level}`)
      if (f.description) parts.push(f.description)
      if (f.protagonistRelation) parts.push(`与主角关系：${f.protagonistRelation}`)
      if (f.coreMembers) parts.push(`核心成员：${f.coreMembers}`)
      if (f.territory) parts.push(`势力范围：${f.territory}`)
      return parts.join('\n')
    })
    .join('\n\n')

  // 7. 追踪状态（落盘后已非空白；loadTrackingState 即使异常也会回退到默认状态，不会返回 undefined）
  const trackingState = await loadTrackingState(novelId)
  const foreshadowView = generateForeshadowView(trackingState)
  // P1：结构化 Story State 摘要（只取当前章及之前的事实，防止未来信息泄漏）
  const storyStateBrief = await safe(async () => {
    const [states, timeline, threads] = await Promise.all([
      listCharacterStates(novelId),
      listTimelineEvents(novelId),
      listPlotThreads(novelId),
    ])
    return buildStoryStateBrief({
      states,
      events: timeline,
      threads,
      chapterOrder: currentChapter?.order ?? options.chapterOrder ?? 0,
      names: Object.fromEntries(characters.map((c) => [c.id, c.name])),
    })
  }, '')
  const trackingStateCard = [generateStateCard(trackingState), storyStateBrief]
    .filter((s) => s && s.trim())
    .join('\n\n')

  // 8. RAG 检索（确保资产已索引）
  await safe(() => loadIndex(novelId), undefined)
  if (getChunks(novelId).length === 0) {
    await safe(() => indexNovelAssets(novelId), undefined)
  }
  // 检索词优先级：hooks 最贴近本次写作语义 → 正文 → 摘要。
  // 重生成模式下旧摘要（options.chapterSummary）不参与检索，防废弃剧情污染 RAG 结果
  const query =
    currentChapter?.hooks?.join('；') ||
    (options.excludeCurrentChapterContent ? '' : options.chapterContent) ||
    (options.excludeCurrentChapterContent ? '' : options.chapterSummary) ||
    currentChapter?.content?.slice(-600) ||
    options.previousMessages.slice(-1)[0]?.content ||
    novel?.title ||
    ''
  const ragContext = buildContextString(search(query, novelId, 8) ?? [])

  // 9. 知识库导航层：优先读 novel.md / 当前卷 / 当前章 / foreshadowings / hooks
  // 重生成模式跳过 KB 的「当前章节简要」——该 md 由旧摘要生成，同样是废弃剧情泄漏源
  const navigationContext = await safe(
    () =>
      knowledgeService.assembleNavigationContext(novelId, options.chapter?.id ?? options.chapterId, {
        excludeCurrentChapterBrief: !!options.excludeCurrentChapterContent,
      }),
    '',
  )

  const summary: ContextSummary = {
    novelTitle: novel?.title ?? '未命名',
    novelDescription: novel?.description ?? '',
    genre,
    targetPlatform: novel?.targetPlatform ?? '',
    volumeTitle,
    currentChapterTitle: currentChapter?.title,
    currentChapterOrder: currentChapter?.order,
    totalChapters,
    totalWordCount,
    committedChapters: trackingState.committedChapters.length,
    activeForeshadowings: trackingState.activeForeshadowings.filter((f) => f.status === 'planted').length,
    characters: characters.length,
  }

  // 11. P2 文风：仅在正文产出/改写时注入；ask/check 与质量门禁不注入
  const wantStyle =
    !options.excludeStyle && (options.agentMode === 'writing' || options.mode === 'craft')
  const stylePrompt = wantStyle
    ? await safe(async () => {
        const merged = await loadMergedStyleForNovel(novelId)
        return renderStylePrompt(merged)
      }, null)
    : null

  const bundle: ContextBundle = {
    novelId,
    summary,
    novel: {
      title: novel?.title ?? '',
      description: novel?.description ?? '',
      genre,
      targetPlatform: novel?.targetPlatform ?? '',
    },
    outline,
    currentChapter,
    adjacentChapters,
    characters,
    charactersText,
    worldviews,
    worldviewsText,
    forces,
    forcesText,
    foreshadowView,
    trackingStateCard,
    sceneCards,
    ragContext,
    navigationContext,
    styleContext: stylePrompt?.text,
    styleMeta: stylePrompt?.meta,
    previousMessages: options.previousMessages,
  }

  // 10. 上下文计划：先算 token、按优先级裁剪，再交给渲染层拼接
  const overrides =
    options.contextPlanOverrides ?? (await safe(() => loadContextPlanOverrides(novelId), {} as ContextPlanOverrides))
  const plan = planContextBundle(bundle, {
    budgetTokens: options.contextWindowTokens,
    task: inferContextTask(options),
    overrides,
  })
  bundle.contextPlan = plan

  // 生成日志：记录裁剪/排除的区块（不记录正文，避免泄露内容）
  const excludedKeys = plan.sections
    .filter((s) => !s.included && (overrides.exclude ?? []).includes(s.key))
    .map((s) => s.key)
  if (plan.dropped.length > 0 || excludedKeys.length > 0) {
    ActionLog.agent('上下文计划裁剪', {
      task: plan.task,
      budget: plan.budgetTokens,
      total: plan.totalTokens,
      dropped: plan.dropped.map((d) => `${d.key}: ${d.reason} (-${d.tokens ?? 0})`),
      excluded: excludedKeys,
    })
  }

  return bundle
}

const SCENE_STATUS_LABEL: Record<string, string> = {
  planned: '待写',
  writing: '写作中',
  written: '已写',
  cut: '废弃',
}

function formatSceneCard(c: SceneCard): string {
  const lines = [
    `第${c.orderNum}场《${c.title || '未命名场景'}》[${SCENE_STATUS_LABEL[c.status] ?? c.status}] 目标字数≈${c.wordTarget}`,
  ]
  if (c.goal) lines.push(`  目标：${c.goal}`)
  if (c.obstacle) lines.push(`  阻力：${c.obstacle}`)
  if (c.turn) lines.push(`  转折：${c.turn}`)
  if (c.outcome) lines.push(`  结果/钩子：${c.outcome}`)
  if (c.emotionBefore || c.emotionAfter) {
    lines.push(`  情绪：${c.emotionBefore || '?'} → ${c.emotionAfter || '?'}`)
  }
  if (c.location) lines.push(`  地点：${c.location}`)
  if (c.storyTime) lines.push(`  故事时间：${c.storyTime}`)
  if (c.characters.length) lines.push(`  出场人物：${c.characters.join('、')}`)
  if (c.props.length) lines.push(`  关键道具：${c.props.join('、')}`)
  if (c.hooks.length) lines.push(`  对应细纲：${c.hooks.join(' / ')}`)
  return lines.join('\n')
}

function composeCanon(b: ContextBundle): string {
  const L: string[] = []
  L.push(`书名：《${b.novel.title}》`)
  if (b.novel.description) L.push(`简介：${b.novel.description}`)
  L.push(`题材：${b.novel.genre.join('、') || '未设定'}`)
  if (b.novel.targetPlatform) L.push(`目标平台：${b.novel.targetPlatform}`)
  if (b.outline) L.push('', '## 大纲', b.outline)
  if (b.worldviewsText) L.push('', '## 世界观设定', b.worldviewsText)
  if (b.forcesText) L.push('', '## 势力格局', b.forcesText)
  if (b.charactersText) L.push('', '## 角色档案', b.charactersText)
  return L.join('\n')
}

function composeState(b: ContextBundle): string {
  const L: string[] = []
  if (b.trackingStateCard) {
    L.push('## 创作状态卡（当前事实，禁止与已写章节冲突）', b.trackingStateCard)
  }
  if (b.foreshadowView) {
    if (L.length) L.push('')
    L.push('## 伏笔与追踪状态', b.foreshadowView)
  }
  return L.join('\n')
}

function composeScene(b: ContextBundle): string {
  const activeScenes = b.sceneCards?.filter((c) => c.status !== 'cut') ?? []
  if (!activeScenes.length) return ''
  return ['## 本章场景卡（施工图，按顺序逐场落实）', activeScenes.map(formatSceneCard).join('\n')].join('\n')
}

function composeCurrent(b: ContextBundle): { header: string; content: string } {
  if (!b.currentChapter) return { header: '', content: '' }
  const L: string[] = [`## 当前章节：第${b.currentChapter.order}章 《${b.currentChapter.title}》`]
  if (b.currentChapter.summary) L.push(`本章摘要：${b.currentChapter.summary}`)
  if (b.currentChapter.hooks?.length) L.push(`本章细纲(hooks)：${b.currentChapter.hooks.join(' / ')}`)
  const n = b.adjacentChapters.next
  if (n) {
    L.push(`下一章（规划预告）：第${n.order}章 《${n.title}》`)
    if (n.hooks?.length) L.push(`规划细纲(hooks)：${n.hooks.join(' / ')}`)
  }
  const content = b.currentChapter.content
    ? `【本章已有正文（续写必须承接此处语气与情节）】\n${b.currentChapter.content}`
    : ''
  return { header: L.join('\n'), content }
}

function composePrevious(b: ContextBundle): string {
  const p = b.adjacentChapters.prev
  if (!p) return ''
  const L: string[] = [`## 上一章：第${p.order}章 《${p.title}》`]
  if (p.summary) L.push(`摘要：${p.summary}`)
  if (p.content) L.push(p.content)
  return L.join('\n')
}

function composeRag(b: ContextBundle): string {
  const L: string[] = []
  if (b.navigationContext) L.push(b.navigationContext)
  if (b.ragContext) {
    if (L.length) L.push('')
    L.push('## 相关资料检索（RAG）', b.ragContext)
  }
  return L.join('\n')
}

function inferContextTask(options: BuildContextOptions): ContextTask {
  if (options.contextTask) return options.contextTask
  if (options.agentMode === 'writing') return 'write'
  if (options.mode === 'craft') return 'revise'
  return 'ask'
}

/**
 * 生成 ContextPlan：先按区块计算 token，再按优先级裁剪，最后才拼成提示词。
 * 预算比例见规划文档 5.4；固定（pin）区块不裁剪，排除（exclude）区块不注入。
 */
export function planContextBundle(
  bundle: ContextBundle,
  opts: { budgetTokens?: number; task?: ContextTask; overrides?: ContextPlanOverrides } = {}
): ContextPlan {
  const budgetTokens = Math.max(2000, Math.floor(opts.budgetTokens ?? 32000))
  const pinned = new Set(opts.overrides?.pin ?? [])
  const excluded = new Set(opts.overrides?.exclude ?? [])
  const sections: ContextSection[] = []
  const dropped: ContextPlan['dropped'] = []
  const rendered: Partial<Record<ContextSectionKey, string>> = {}

  const addSection = (
    key: ContextSectionKey,
    tokens: number,
    included: boolean,
    reason: string,
    content?: string
  ) => {
    sections.push({
      key,
      priority: SECTION_PRIORITY[key],
      tokens: included ? tokens : 0,
      included,
      reason,
      content: included && content !== undefined ? content : undefined,
    })
    if (included && content !== undefined) rendered[key] = content
  }

  // 1. 安全/系统约束：固定成本，不裁剪
  addSection('safety', Math.floor(budgetTokens * 0.10), true, '预留：系统提示与安全约束')

  // 2. Canon 事实：最后才裁，保证事实完整
  const canonText = excluded.has('canon') ? '' : composeCanon(bundle)
  const canonBudget = Math.floor(budgetTokens * 0.25)
  let canonOut = canonText
  if (canonText) {
    const tokens = estimateTokens(canonText)
    if (tokens > canonBudget && !pinned.has('canon')) {
      const t = truncateToTokens(canonText, canonBudget, 'head')
      canonOut = t.text
      dropped.push({ key: 'canon', reason: '超出作品事实预算，保留前半', tokens: tokens - t.tokens })
    }
    addSection(
      'canon',
      estimateTokens(canonOut),
      true,
      excludedReason(excluded, 'canon') ?? (estimateTokens(canonOut) < tokens ? '按预算裁剪' : pinned.has('canon') ? '固定：不裁剪' : '按预算入选'),
      canonOut
    )
  } else {
    addSection('canon', 0, false, excludedReason(excluded, 'canon') ?? '无作品资料')
  }

  // 3. 场景卡 + 当前章（共享 25%）：先裁当前章旧正文，保场景卡与 hooks
  const sceneText = excluded.has('scene') ? '' : composeScene(bundle)
  const currentParts = excluded.has('current') ? { header: '', content: '' } : composeCurrent(bundle)
  const sceneCurrentBudget = Math.floor(budgetTokens * 0.25)
  let sceneOut = sceneText
  let headerOut = currentParts.header
  let contentOut = currentParts.content

  {
    let s = estimateTokens(sceneOut)
    let h = estimateTokens(headerOut)
    let c = estimateTokens(contentOut)
    const sceneExempt = pinned.has('scene') || excluded.has('scene')
    const currentExempt = pinned.has('current') || excluded.has('current')

    if (s + h + c > sceneCurrentBudget) {
      if (!currentExempt && c > 0) {
        const avail = Math.max(0, sceneCurrentBudget - s - h)
        if (c > avail) {
          const t = truncateToTokens(contentOut, avail, 'tail')
          dropped.push({ key: 'current', reason: '超出场景/当前章预算，先裁旧正文', tokens: c - t.tokens })
          contentOut = t.text
          c = t.tokens
        }
      }
      if (!sceneExempt && s + h + c > sceneCurrentBudget) {
        const avail = Math.max(0, sceneCurrentBudget - h - c)
        if (s > avail) {
          const t = truncateToTokens(sceneOut, avail, 'head')
          dropped.push({ key: 'scene', reason: '超出场景/当前章预算，裁剪场景卡', tokens: s - t.tokens })
          sceneOut = t.text
          s = t.tokens
        }
      }
      if (!currentExempt && s + h + c > sceneCurrentBudget) {
        const avail = Math.max(0, sceneCurrentBudget - s - c)
        if (h > avail) {
          const t = truncateToTokens(headerOut, avail, 'head')
          dropped.push({ key: 'current', reason: '超出场景/当前章预算，裁剪本章标题与细纲', tokens: h - t.tokens })
          headerOut = t.text
        }
      }
    }
  }

  const currentOut = [headerOut, contentOut].filter(Boolean).join('\n\n')
  addSection(
    'scene',
    estimateTokens(sceneOut),
    !excluded.has('scene') && !!sceneOut.trim(),
    excludedReason(excluded, 'scene') ?? (sceneOut !== sceneText ? '按预算裁剪' : pinned.has('scene') ? '固定：不裁剪' : '按预算入选'),
    sceneOut
  )
  addSection(
    'current',
    estimateTokens(currentOut),
    !excluded.has('current') && !!currentOut.trim(),
    excludedReason(excluded, 'current') ??
      (currentOut !== [currentParts.header, currentParts.content].filter(Boolean).join('\n\n')
        ? '按预算裁剪'
        : pinned.has('current') ? '固定：不裁剪' : currentOut ? '按预算入选' : '无当前章节'),
    currentOut
  )

  // 4. 上一章 + 状态卡（共享 15%）：先裁上一章正文，状态卡保 7 栏完整
  const stateText = excluded.has('state') ? '' : composeState(bundle)
  const previousText = excluded.has('previous') ? '' : composePrevious(bundle)
  const previousStateBudget = Math.floor(budgetTokens * 0.15)
  let stateOut = stateText
  let previousOut = previousText
  {
    const s = estimateTokens(stateOut)
    const p = estimateTokens(previousOut)
    if (s + p > previousStateBudget) {
      if (!pinned.has('previous') && previousOut) {
        const avail = Math.max(0, previousStateBudget - s)
        if (p > avail) {
          const t = truncateToTokens(previousOut, avail, 'tail')
          dropped.push({ key: 'previous', reason: '超出上一章/状态预算，先裁上一章正文', tokens: p - t.tokens })
          previousOut = t.text
        }
      }
      if (!pinned.has('state') && stateOut) {
        const current = estimateTokens(stateOut)
        if (current > previousStateBudget) {
          const t = truncateToTokens(stateOut, previousStateBudget, 'head')
          dropped.push({ key: 'state', reason: '超出上一章/状态预算，裁剪伏笔视图', tokens: current - t.tokens })
          stateOut = t.text
        }
      }
    }
  }
  addSection(
    'state',
    estimateTokens(stateOut),
    !excluded.has('state') && !!stateOut.trim(),
    excludedReason(excluded, 'state') ?? (stateOut !== stateText ? '按预算裁剪' : pinned.has('state') ? '固定：不裁剪' : stateOut ? '按预算入选' : '暂无状态'),
    stateOut
  )
  addSection(
    'previous',
    estimateTokens(previousOut),
    !excluded.has('previous') && !!previousOut.trim(),
    excludedReason(excluded, 'previous') ?? (previousOut !== previousText ? '按预算裁剪' : pinned.has('previous') ? '固定：不裁剪' : previousOut ? '按预算入选' : '无上一章'),
    previousOut
  )

  // 5. RAG + 导航（10%）：从尾部裁剪，导航层在前优先保留
  const ragText = excluded.has('rag') ? '' : composeRag(bundle)
  const ragBudget = Math.floor(budgetTokens * 0.10)
  let ragOut = ragText
  if (ragText) {
    const tokens = estimateTokens(ragText)
    if (tokens > ragBudget && !pinned.has('rag')) {
      const t = truncateToTokens(ragText, ragBudget, 'tail')
      ragOut = t.text
      dropped.push({ key: 'rag', reason: '超出检索预算，从低相关条目裁起', tokens: tokens - t.tokens })
    }
    addSection(
      'rag',
      estimateTokens(ragOut),
      true,
      excludedReason(excluded, 'rag') ?? (estimateTokens(ragOut) < tokens ? '按预算裁剪' : pinned.has('rag') ? '固定：不裁剪' : '按预算入选'),
      ragOut
    )
  } else {
    addSection('rag', 0, false, excludedReason(excluded, 'rag') ?? '暂无检索资料')
  }

  // 6. 文风区块（P2）：融合后的提示词文本，只影响表达方式
  const styleText = excluded.has('style') ? '' : (bundle.styleContext ?? '')
  if (styleText) {
    const styleBudget = Math.floor(budgetTokens * 0.05)
    let styleOut = styleText
    const tokens = estimateTokens(styleText)
    if (tokens > styleBudget && !pinned.has('style')) {
      const t = truncateToTokens(styleText, styleBudget, 'tail')
      styleOut = t.text
      dropped.push({ key: 'style', reason: '超出文风预算，从低优先级片段裁起', tokens: tokens - t.tokens })
    }
    addSection(
      'style',
      estimateTokens(styleOut),
      true,
      excludedReason(excluded, 'style') ??
        (estimateTokens(styleOut) < tokens ? '按预算裁剪' : pinned.has('style') ? '固定：不裁剪' : '已绑定文风配方'),
      styleOut
    )
  } else {
    addSection('style', 0, false, excludedReason(excluded, 'style') ?? '未绑定文风画像')
  }

  // 7. 历史消息：从最旧开始裁剪，调用方按 historyBudgetTokens 取用
  const historyBudget = Math.floor(budgetTokens * 0.07)
  const recentHistory = bundle.previousMessages.slice(-10)
  const historyTokens = recentHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const historyIncluded = recentHistory.length > 0 && !excluded.has('history')
  addSection(
    'history',
    Math.min(historyTokens, historyBudget),
    historyIncluded,
    excludedReason(excluded, 'history') ??
      (historyTokens > historyBudget ? '按预算保留最近对话' : historyIncluded ? '最近对话' : '无历史对话')
  )
  if (historyIncluded && historyTokens > historyBudget && !pinned.has('history')) {
    dropped.push({ key: 'history', reason: '超出历史对话预算，从最旧开始丢弃', tokens: historyTokens - historyBudget })
  }

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0)
  return {
    task: opts.task ?? 'write',
    budgetTokens,
    totalTokens,
    sections,
    dropped,
    rendered,
    historyBudgetTokens: historyBudget,
  }
}

function excludedReason(excluded: Set<ContextSectionKey>, key: ContextSectionKey): string | undefined {
  return excluded.has(key) ? '用户已排除（本次不注入）' : undefined
}

/** 按 ContextPlan 的历史预算裁剪对话消息：保留最近消息，从最旧开始丢。 */
export function trimHistoryForPlan<T extends { role: string; content: string }>(
  messages: T[],
  plan?: ContextPlan,
  maxMessages = 10
): T[] {
  const recent = messages.slice(-maxMessages)
  const budget = plan?.historyBudgetTokens
  if (budget == null || !recent.length) return recent

  const kept: T[] = []
  let used = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(recent[i].content)
    // 至少保留最近一条，避免完全失去上下文
    if (kept.length > 0 && used + tokens > budget) break
    kept.unshift(recent[i])
    used += tokens
  }
  return kept
}

/** 将 ContextBundle 格式化为可注入 system prompt 的资料区块。 */
export function buildContextStringFromBundle(b: ContextBundle): string {
  if (!b.novelId) return ''
  const plan = b.contextPlan
  if (plan?.rendered) {
    const r = plan.rendered
    const L: string[] = []
    // 导航层 + 检索资料置于最前
    if (r.rag) {
      L.push(r.rag)
      L.push('')
    }
    L.push('# 小说资料（撰写前必读，严禁偏离）')
    if (r.canon) {
      L.push(r.canon)
      L.push('')
    }
    if (r.state) {
      L.push(r.state)
      L.push('')
    }
    if (r.scene) {
      L.push(r.scene)
      L.push('')
    }
    if (r.current) {
      L.push(r.current)
      L.push('')
    }
    if (r.previous) {
      L.push(r.previous)
      L.push('')
    }
    if (r.style) {
      L.push(r.style)
    }
    return L.join('\n').trim()
  }

  // 兜底：未产出 ContextPlan 时按原固定顺序拼接（预览/测试构造的 bundle）
  const L: string[] = []
  if (b.navigationContext) {
    L.push(b.navigationContext)
    L.push('')
  }
  L.push('# 小说资料（撰写前必读，严禁偏离）')
  L.push(`书名：《${b.novel.title}》`)
  if (b.novel.description) L.push(`简介：${b.novel.description}`)
  L.push(`题材：${b.novel.genre.join('、') || '未设定'}`)
  if (b.novel.targetPlatform) L.push(`目标平台：${b.novel.targetPlatform}`)
  L.push('')
  L.push('## 大纲')
  L.push(b.outline || '（暂无）')
  L.push('')
  if (b.trackingStateCard) {
    L.push('## 创作状态卡（当前事实，禁止与已写章节冲突）')
    L.push(b.trackingStateCard)
    L.push('')
  }
  if (b.worldviewsText) {
    L.push('## 世界观设定')
    L.push(b.worldviewsText)
    L.push('')
  }
  if (b.forcesText) {
    L.push('## 势力格局')
    L.push(b.forcesText)
    L.push('')
  }
  if (b.charactersText) {
    L.push('## 角色档案')
    L.push(b.charactersText)
    L.push('')
  }
  if (b.currentChapter) {
    L.push(`## 当前章节：第${b.currentChapter.order}章 《${b.currentChapter.title}》`)
    if (b.currentChapter.summary) L.push(`本章摘要：${b.currentChapter.summary}`)
    if (b.currentChapter.hooks?.length) L.push(`本章细纲(hooks)：${b.currentChapter.hooks.join(' / ')}`)
    const activeScenes = b.sceneCards?.filter((c) => c.status !== 'cut') ?? []
    if (activeScenes.length) {
      L.push('')
      L.push('## 本章场景卡（施工图，按顺序逐场落实）')
      L.push(activeScenes.map(formatSceneCard).join('\n'))
    }
    if (b.currentChapter.content) {
      L.push('【本章已有正文（续写必须承接此处语气与情节）】')
      L.push(b.currentChapter.content.slice(-2200))
    }
    L.push('')
  }
  if (b.adjacentChapters.prev) {
    const p = b.adjacentChapters.prev
    L.push(`## 上一章：第${p.order}章 《${p.title}》`)
    if (p.summary) L.push(`摘要：${p.summary}`)
    if (p.content) L.push(p.content.slice(-1600))
    L.push('')
  }
  if (b.adjacentChapters.next) {
    const n = b.adjacentChapters.next
    L.push(`## 下一章（规划预告）：第${n.order}章 《${n.title}》`)
    if (n.hooks?.length) L.push(`规划细纲(hooks)：${n.hooks.join(' / ')}`)
    L.push('')
  }
  if (b.foreshadowView) {
    L.push('## 伏笔与追踪状态')
    L.push(b.foreshadowView)
    L.push('')
  }
  if (b.ragContext) {
    L.push('## 相关资料检索（RAG）')
    L.push(b.ragContext)
    L.push('')
  }
  if (b.styleContext) {
    L.push(b.styleContext)
  }
  return L.join('\n')
}
