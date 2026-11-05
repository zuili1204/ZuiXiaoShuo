// P2 文风分析：规范化语料 → 全量定量指标 → 分层抽样逐章 LLM 分析 → 确定性聚合 → 草稿画像。
// LLM 只分析“怎么写”，禁止总结情节/人物关系/世界观；失败降级为指标画像，不阻断保存。
import type { AgentConfig } from '@shared/types'
import type {
  CorpusManifest,
  StyleAnchor,
  StyleAnchorKind,
  StyleCategorical,
  StyleCraftData,
  StyleDimension,
  StyleDimensionKey,
  StyleProfile,
  StyleProfileData,
  StyleRule,
  StyleSampleStats,
  StyleSourceKind,
} from '@shared/style-types'
import { getAgent, callLLM, extractJson } from './ai-outline'
import { agentConfigService } from './data-service'
import { ActionLog } from './log-service'
import {
  aggregateStyleMetrics,
  computeTitleMetrics,
  STYLE_METRIC_VERSION,
  sampleChapterIndexes,
} from '@shared/style-metrics'
import { mergeStyleCraft, normalizeStyleCraft, redactCraftNames, voiceDispersion } from '@shared/style-craft'
import { hashText } from '@shared/chapter-split'
import {
  getStyleSource,
  latestStyleProfile,
  listStyleProfiles,
  newStyleProfileId,
  replaceStyleAnchors,
  saveStyleProfile,
  saveStyleSource,
  updateStyleSourceStatus,
  loadStyleDefaults,
} from './style-service'

export const STYLE_PROMPT_VERSION = 'p2-2.0'
const CHAPTER_TEXT_LIMIT = 12_000
const MAX_ANCHOR_CHARS = 160
const DIMENSION_KEYS: StyleDimensionKey[] = [
  'pov_tense',
  'syntax',
  'lexicon',
  'dialogue',
  'description',
  'interiority',
  'humor_tone',
  'characterization',
  'pacing_hooks',
  'chapter_engineering',
  'hook_design',
  'relationship_engine',
  'setting_function',
  'meta_humor',
  'concreteness',
  'taboo_boundary',
  'character_voice',
]

export interface StyleAnalysisProgress {
  phase: 'load' | 'metrics' | 'sample' | 'analyze' | 'aggregate' | 'save' | 'done' | 'error'
  message: string
  chapterIndex?: number
  chapterTotal?: number
}

export interface AnalyzeStyleOptions {
  sampleCount?: 12 | 24 | 30
  signal?: AbortSignal
  onProgress?: (p: StyleAnalysisProgress) => void
}

interface RawChapterAnalysis {
  summary?: string
  categorical?: Partial<StyleCategorical>
  dimensions?: { key?: string; value?: string; confidence?: number; evidence?: string[] }[]
  rules?: {
    do?: { text?: string; confidence?: number; evidence?: string }[]
    dont?: { text?: string; confidence?: number; evidence?: string }[]
  }
  lexicon?: { preferred?: string[]; avoid?: string[] }
  sourceEntities?: string[]
  anchors?: { kind?: string; text?: string }[]
  /** 叙事工程层原始结构，聚合前用 normalizeStyleCraft 收紧 */
  craft?: unknown
  confidence?: number
}

interface SampleRecord {
  index: number
  title: string
  chars: number
  analysis: RawChapterAnalysis | null
  failed?: boolean
}

interface SampleFile {
  analysisKey: string
  promptVersion: string
  model: string
  complete: boolean
  records: SampleRecord[]
}

function emit(options: AnalyzeStyleOptions, p: StyleAnalysisProgress) {
  try {
    options.onProgress?.(p)
  } catch {
    // 进度回调异常不影响分析
  }
}

function abortError(): Error {
  const err = new Error('已取消分析')
  err.name = 'AbortError'
  return err
}

async function pickAnalysisAgent(): Promise<AgentConfig | null> {
  const defaults = await loadStyleDefaults()
  if (defaults.agentId) {
    const agents = await agentConfigService.getAll()
    const picked = agents.find((a) => a.id === defaults.agentId)
    if (picked) return picked
  }
  return getAgent()
}

/** 密钥/额度/模型名这类配置错误：后续章节必然同样失败，直接中止。 */
function isFatalModelError(detail: string): boolean {
  if (/\((400|401|402|403|404|429)\)/.test(detail)) return true
  return /invalid api key|authentication fail|unauthorized|insufficient (balance|quota)|api key.*(invalid|expired)/i.test(detail)
}

function friendlyModelError(agent: AgentConfig, detail: string): string {
  const name = agent.name || '文风分析模型'
  if (/\((401|403)\)/.test(detail) || /invalid api key|authentication fail|unauthorized|api key.*(invalid|expired)/i.test(detail)) {
    return `文风分析模型的密钥无效或已过期，请在设置中更新「${name}」的密钥后重试`
  }
  if (/\((402|429)\)/.test(detail) || /insufficient|quota|balance/i.test(detail)) {
    return `文风分析模型的额度不足或请求受限，请在设置中检查「${name}」的额度后重试`
  }
  if (/\(404\)/.test(detail)) {
    return `文风分析使用的模型不可用，请在设置中检查「${name}」的模型名称后重试`
  }
  if (/\(400\)/.test(detail)) {
    return `文风分析请求被模型拒绝，请在设置中检查「${name}」的模型参数后重试`
  }
  return `文风分析模型调用失败，请检查「${name}」的配置后重试`
}

interface ChapterAnalysisResult {
  analysis: RawChapterAnalysis | null
  /** 可直接展示给用户的失败原因 */
  error?: string
  /** 原始错误信息，仅写日志 */
  detail?: string
  fatal?: boolean
}

async function analyzeChapter(
  agent: AgentConfig,
  title: string,
  content: string,
  signal?: AbortSignal,
): Promise<ChapterAnalysisResult> {
  let lastError = ''
  let lastDetail = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw abortError()
    try {
      const raw = await callLLM(agent, '', buildAnalyzePrompt(title, content), signal)
      if (signal?.aborted) throw abortError()
      const parsed = parseAnalysis(raw)
      if (parsed) return { analysis: parsed }
      lastError = raw.trim() ? '模型返回内容无法解析为文风数据' : '模型未返回内容'
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      const detail = (e as Error)?.message || String(e)
      lastDetail = detail
      lastError = friendlyModelError(agent, detail)
      if (isFatalModelError(detail)) {
        return { analysis: null, error: lastError, detail, fatal: true }
      }
    }
  }
  return { analysis: null, error: lastError || '模型未返回内容', detail: lastDetail }
}

function buildAnalyzePrompt(title: string, content: string): string {
  return (
    '你是一名小说文风分析师。只分析“怎么写”，禁止总结情节、人物关系、世界观剧情；不要复述故事内容。\n' +
    '叙事工程层（craft）只抽取可迁移的结构：功能位、可重复场景、角色声音、章节工程、关系/情节引擎、禁忌。禁止输出原书真实人名、地名、组织名；角色声音用功能位称谓（主角/搭档/对手/师长/旁支角色），场景写成抽象动作（如“教室后排递纸条”）。\n' +
    '每条判断必须带原文证据（≤60 字，出现真名时替换成“甲/乙”），不确定就给低 confidence（0~1）；没有把握的 craft 字段宁可留空，禁止编造。\n' +
    '输出纯 JSON（不要 Markdown 代码块），格式：\n' +
    '{"summary":"≤120字总体语感","categorical":{"pov":"first/third_limited/third_omniscient/mixed/unknown","tense":"past/present/mixed/unknown","tone":"基调词","register":"口语/书面/文学"},"dimensions":[{"key":"pov_tense/syntax/lexicon/dialogue/description/interiority/humor_tone/characterization/pacing_hooks/chapter_engineering/hook_design/relationship_engine/setting_function/meta_humor/concreteness/taboo_boundary/character_voice","value":"≤80字结论","confidence":0.0,"evidence":["≤60字原文"]}],"rules":{"do":[{"text":"可执行规则","confidence":0.0,"evidence":"原文"}],"dont":[{"text":"要避免的写法","confidence":0.0,"evidence":"原文"}]},"lexicon":{"preferred":["偏好词"],"avoid":["回避词"]},"sourceEntities":["人名/地名/专有名词，最多20个"],"anchors":[{"kind":"dialogue/action/description/interior/transition/chapter_end","text":"≤160字原文片段"}],"craft":{"functionPositions":[{"key":"visible_progress_bar/repeatable_ritual/intimate_excuse/public_relationship_map/meta_safety_valve","description":"这个功能位在本章怎么干活（≤80字，不写专有名词）","evidence":["≤60字原文，真名替换为甲/乙"],"transferable":true,"settingDependency":"low/medium/high"}],"sceneBank":[{"scene":"抽象场景","function":"推进关系/制造笑点/公开信息/日常仪式","frequency":1,"transferable":true}],"voices":[{"characterRole":"主角/搭档/对手/师长/旁支角色","sentenceAvgLen":0,"ellipsisPerChapter":0,"questionPerChapter":0,"exclaimPerChapter":0,"verbalTics":["可归纳的口头禅，不含真名"],"tabooPhrases":["这个角色不会说的话"],"evidence":["≤60字，真名替换为甲/乙"]}],"taboos":["作者不写的套路"],"chapterEngineering":{"openingPatterns":["开篇手法"],"endingPatterns":["章末停留方式"],"titlePatterns":["标题写法"]},"relationshipEngine":["关系升级/退化的状态机规则"],"plotEngine":["冲突如何反复发生，不以越用越惨为默认"],"comparison":[{"dimension":"对照维度","author":"作者做法","aiDefault":"AI常见默认","rule":"对应可执行规则"}]},"confidence":0.0}\n' +
    `十七维必须尽量覆盖；未发现给空字符串并低 confidence。craft 只填本章确实观察到的项，可为空对象。anchors 给 2~4 条最能代表语感的短片段（只摘原文，不改写）。\n\n` +
    `==== 章节标题 ====\n${title}\n==== 章节正文 ====\n${content.slice(0, CHAPTER_TEXT_LIMIT)}`
  )
}

function parseAnalysis(raw: string): RawChapterAnalysis | null {
  const json = extractJson(raw)
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as RawChapterAnalysis) : null
  } catch {
    return null
  }
}

function sanitizeConfidence(n: unknown, fallback = 0.3): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback
}

function normalizeText(t: unknown, max: number): string {
  return typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

// ===== 确定性聚合 =====

function weightedVote<T extends string>(items: { value: T; weight: number }[]): { value: T | 'unknown'; conflict: boolean } {
  const tally = new Map<T, number>()
  for (const item of items) {
    if (!item.value || item.value === ('unknown' as T)) continue
    tally.set(item.value, (tally.get(item.value) ?? 0) + Math.max(0.01, item.weight))
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
  if (!ranked.length) return { value: 'unknown', conflict: false }
  const conflict = ranked.length > 1 && ranked[1][1] / ranked[0][1] > 0.8
  return { value: ranked[0][0], conflict }
}

function aggregateCategorical(records: SampleRecord[]): StyleCategorical {
  const pov = weightedVote(
    records.map((r) => ({ value: r.analysis?.categorical?.pov ?? 'unknown', weight: r.chars * sanitizeConfidence(r.analysis?.confidence) })),
  ).value
  const tense = weightedVote(
    records.map((r) => ({ value: r.analysis?.categorical?.tense ?? 'unknown', weight: r.chars * sanitizeConfidence(r.analysis?.confidence) })),
  ).value
  const tone = topString(records.map((r) => r.analysis?.categorical?.tone ?? ''))
  const register = topString(records.map((r) => r.analysis?.categorical?.register ?? ''))
  return {
    pov: (pov === 'unknown' ? 'unknown' : pov) as StyleCategorical['pov'],
    tense: (tense === 'unknown' ? 'unknown' : tense) as StyleCategorical['tense'],
    tone,
    register,
  }
}

function topString(values: string[]): string {
  const tally = new Map<string, number>()
  for (const v of values) if (v.trim()) tally.set(v, (tally.get(v) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function aggregateDimensions(records: SampleRecord[]): StyleDimension[] {
  const byKey = new Map<StyleDimensionKey, StyleDimension & { weight: number; variants: string[] }>()
  for (const record of records) {
    for (const dim of record.analysis?.dimensions ?? []) {
      const key = String(dim.key ?? '') as StyleDimensionKey
      if (!DIMENSION_KEYS.includes(key)) continue
      const value = normalizeText(dim.value, 80)
      if (!value) continue
      const confidence = sanitizeConfidence(dim.confidence)
      const prev = byKey.get(key)
      if (!prev) {
        byKey.set(key, {
          key,
          value,
          confidence,
          evidence: (dim.evidence ?? []).map((e) => normalizeText(e, 60)).filter(Boolean).slice(0, 2),
          weight: record.chars,
          variants: [],
        })
      } else {
        prev.weight += record.chars
        prev.variants.push(value)
        if (confidence > prev.confidence) {
          prev.value = value
          prev.confidence = confidence
          prev.evidence = (dim.evidence ?? []).map((e) => normalizeText(e, 60)).filter(Boolean).slice(0, 2)
        }
      }
    }
  }
  return DIMENSION_KEYS.map((key) => {
    const found = byKey.get(key)
    if (!found) return { key, value: '', confidence: 0, evidence: [] }
    return {
      key,
      value: found.value,
      confidence: +found.confidence.toFixed(2),
      evidence: found.evidence,
      variants: found.variants.filter((v) => v !== found.value).slice(0, 2),
    }
  })
}

function aggregateRules(records: SampleRecord[]): { do: StyleRule[]; dont: StyleRule[] } {
  const collect = (kind: 'do' | 'dont'): StyleRule[] => {
    const map = new Map<string, { text: string; score: number; confidence: number; evidence?: string }>()
    for (const record of records) {
      for (const rule of record.analysis?.rules?.[kind] ?? []) {
        const text = normalizeText(rule.text, 80)
        if (!text) continue
        const key = text.replace(/[，。；、,.;:：\s]/g, '').toLowerCase()
        const confidence = sanitizeConfidence(rule.confidence)
        const cur = map.get(key)
        if (!cur) map.set(key, { text, score: confidence, confidence, evidence: normalizeText(rule.evidence, 60) })
        else {
          cur.score += confidence
          cur.confidence = Math.max(cur.confidence, confidence)
          if (!cur.evidence) cur.evidence = normalizeText(rule.evidence, 60)
        }
      }
    }
    return [...map.values()]
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
      .slice(0, 12)
      .map((r) => ({
        text: r.text,
        confidence: +r.confidence.toFixed(2),
        evidence: r.evidence,
        tier: r.confidence >= 0.6 ? 'must' : 'should',
      }))
  }
  return { do: collect('do'), dont: collect('dont') }
}

function aggregateLexicon(records: SampleRecord[]): { preferred: string[]; avoid: string[] } {
  const preferred = new Set<string>()
  const avoid = new Set<string>()
  for (const record of records) {
    for (const w of record.analysis?.lexicon?.preferred ?? []) {
      const t = normalizeText(w, 12)
      if (t) preferred.add(t)
    }
    for (const w of record.analysis?.lexicon?.avoid ?? []) {
      const t = normalizeText(w, 12)
      if (t) avoid.add(t)
    }
  }
  for (const w of avoid) preferred.delete(w)
  return { preferred: [...preferred].slice(0, 20), avoid: [...avoid].slice(0, 20) }
}

function aggregateEntities(records: SampleRecord[], max = 20): string[] {
  const tally = new Map<string, number>()
  for (const record of records) {
    for (const e of record.analysis?.sourceEntities ?? []) {
      const name = normalizeText(e, 20)
      if (name) tally.set(name, (tally.get(name) ?? 0) + 1)
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, max)
}

function aggregateCraft(records: SampleRecord[]): StyleCraftData | undefined {
  return mergeStyleCraft(
    records.map((record) => ({
      craft: record.analysis?.craft ? normalizeStyleCraft(record.analysis.craft) : null,
      weight: record.chars,
    })),
  )
}

function buildSummary(records: SampleRecord[]): string {
  const texts = records
    .map((r) => normalizeText(r.analysis?.summary, 120))
    .filter(Boolean)
  if (!texts.length) return '（模型未返回总体语感，定量指标仍可用）'
  return topLongest(texts).slice(0, 200)
}

function topLongest(values: string[]): string {
  return [...values].sort((a, b) => b.length - a.length)[0] ?? ''
}

function confidenceOf(records: SampleRecord[], coverage: number): number {
  const scores = records
    .map((r) => (r.analysis ? sanitizeConfidence(r.analysis.confidence) : 0))
    .filter((n) => n > 0)
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
  return +Math.max(0, Math.min(1, avg * coverage)).toFixed(2)
}

// ===== 锚点 =====

function normalizeAnchorKind(raw: unknown): StyleAnchorKind {
  const k = String(raw ?? '')
  if (['dialogue', 'action', 'description', 'interior', 'transition', 'chapter_end'].includes(k)) {
    return k as StyleAnchorKind
  }
  return 'other'
}

function anchorFromText(profileId: string, text: string, kind: StyleAnchorKind, chapterIndex: number, quality: number, origin: 'excerpt' | 'llm'): StyleAnchor | null {
  const clean = normalizeText(text, MAX_ANCHOR_CHARS)
  if (clean.length < 20) return null
  return {
    id: `san_${hashText(`${profileId}:${chapterIndex}:${clean}`)}`,
    profileId,
    kind,
    text: clean,
    charCount: clean.length,
    chapterIndex,
    quality: Math.max(0, Math.min(1, quality)),
    origin,
    createdAt: new Date().toISOString(),
  }
}

function buildAnchors(
  profileId: string,
  records: SampleRecord[],
  chapters: { content: string }[],
): StyleAnchor[] {
  const out: StyleAnchor[] = []
  const seen = new Set<string>()
  for (const record of records) {
    for (const raw of record.analysis?.anchors ?? []) {
      const anchor = anchorFromText(
        profileId,
        String(raw.text ?? ''),
        normalizeAnchorKind(raw.kind),
        record.index,
        record.analysis ? sanitizeConfidence(record.analysis.confidence, 0.5) : 0.4,
        'llm',
      )
      if (anchor && !seen.has(anchor.text)) {
        seen.add(anchor.text)
        out.push(anchor)
      }
    }
  }
  // 模型没给足时，从抽样章节确定性地取代表性短句（对话/内心/比喻/动作）
  for (const record of records) {
    if (out.length >= 12) break
    const text = chapters[record.index]?.content ?? ''
    for (const candidate of pickRepresentativeSentences(text)) {
      if (out.length >= 12) break
      if (seen.has(candidate.text)) continue
      const anchor = anchorFromText(profileId, candidate.text, candidate.kind, record.index, 0.35, 'excerpt')
      if (anchor) {
        seen.add(anchor.text)
        out.push(anchor)
      }
    }
  }
  return out
}

function pickRepresentativeSentences(text: string): { text: string; kind: StyleAnchorKind }[] {
  const sentences = text
    .split(/(?<=[。！？!?…])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= MAX_ANCHOR_CHARS)
  const out: { text: string; kind: StyleAnchorKind }[] = []
  const pick = (kind: StyleAnchorKind, test: (s: string) => boolean) => {
    const found = sentences.find((s) => test(s))
    if (found && !out.some((o) => o.text === found)) out.push({ text: found, kind })
  }
  pick('dialogue', (s) => /[“”"「」]/.test(s))
  pick('interior', (s) => /(心想|心里|心中|暗自|觉得|感到|意识到)/.test(s))
  pick('description', (s) => /(像|仿佛|如同|似的|宛如|犹如)/.test(s))
  pick('action', (s) => /(走|跑|站|坐|抬|低|转|推|拉|握|放|看|听)/.test(s))
  return out
}

// ===== 主流程 =====

async function loadChapters(sourceId: string, manifest: CorpusManifest): Promise<{ content: string }[]> {
  const chapters: { content: string }[] = []
  for (const chapter of manifest.chapters) {
    try {
      chapters.push({ content: await window.electronAPI.file.read(chapter.path) })
    } catch {
      chapters.push({ content: '' })
    }
  }
  return chapters
}

function sampleKey(input: { model: string; sampleCount: number; contentHash: string; indexes: number[] }): string {
  return hashText(
    `${STYLE_PROMPT_VERSION}|${input.model}|${input.sampleCount}|${input.contentHash}|${input.indexes.join(',')}`,
  )
}

async function readSampleFile(sourceId: string): Promise<SampleFile | null> {
  try {
    const raw = await window.electronAPI.file.read(`content/styles/${sourceId}/profile/samples.json`)
    return JSON.parse(raw) as SampleFile
  } catch {
    return null
  }
}

async function writeSampleFile(sourceId: string, data: SampleFile): Promise<void> {
  try {
    await window.electronAPI.file.write(`content/styles/${sourceId}/profile/samples.json`, JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('[style] write samples failed:', e)
  }
}

/** 分析一个来源并生成草稿画像；已有同 key 的完整采样直接复用。 */
export async function analyzeStyleSource(
  sourceId: string,
  options: AnalyzeStyleOptions = {},
): Promise<StyleProfile> {
  emit(options, { phase: 'load', message: '正在读取语料…' })
  const source = await getStyleSource(sourceId)
  if (!source) throw new Error('来源不存在，请重新导入')
  let manifest: CorpusManifest
  try {
    manifest = JSON.parse(await window.electronAPI.file.read(source.manifestPath || `content/styles/${sourceId}/manifest.json`))
  } catch {
    throw new Error('语料清单缺失，请重新导入')
  }
  if (!manifest.chapters?.length) throw new Error('来源中没有可分析的章节')

  await updateStyleSourceStatus(sourceId, 'analyzing')
  const chapters = await loadChapters(sourceId, manifest)
  emit(options, { phase: 'metrics', message: `正在计算 ${chapters.length} 章定量指标…` })
  const axes = aggregateStyleMetrics(
    chapters.map((chapter, i) => ({ content: chapter.content, title: manifest.chapters[i]?.title ?? '' })),
  )

  const agent = await pickAnalysisAgent()
  if (!agent) {
    await updateStyleSourceStatus(sourceId, 'failed')
    throw new Error('未找到可用的 Agent 配置，请先在设置中添加模型')
  }
  const defaults = await loadStyleDefaults()
  const sampleCount = options.sampleCount ?? defaults.sampleCount
  const indexes = sampleChapterIndexes(manifest.chapters.length, sampleCount, Number.parseInt(manifest.contentHash.slice(0, 6), 16) || 0)
  const analysisKey = sampleKey({
    model: agent.model,
    sampleCount,
    contentHash: manifest.contentHash,
    indexes,
  })
  const cached = await readSampleFile(sourceId)
  // 只复用真正拿到分析结果的章节；上次全部失败的缓存会让重试永远“复用”空结果
  const cachedByIndex = new Map<number, SampleRecord>()
  if (cached?.analysisKey === analysisKey && cached.complete) {
    for (const record of cached.records) {
      if (record.analysis) cachedByIndex.set(record.index, record)
    }
  }
  const pendingCount = indexes.filter((index) => !cachedByIndex.has(index)).length
  const reuse = pendingCount < indexes.length

  emit(options, {
    phase: 'sample',
    message: !reuse
      ? `已抽样 ${indexes.length} 章（首/中/末必含）`
      : pendingCount === 0
        ? `复用上次分析结果（${indexes.length} 章）`
        : `复用 ${indexes.length - pendingCount} 章，补分析 ${pendingCount} 章`,
  })

  const records: SampleRecord[] = []
  const sampleFile: SampleFile = {
    analysisKey,
    promptVersion: STYLE_PROMPT_VERSION,
    model: agent.model,
    complete: false,
    records: [],
  }
  const failures: { title: string; error: string }[] = []
  try {
    for (let i = 0; i < indexes.length; i++) {
      if (options.signal?.aborted) throw abortError()
      const index = indexes[i]
      const cachedRecord = cachedByIndex.get(index)
      if (cachedRecord) {
        records.push(cachedRecord)
        continue
      }
      const chapter = manifest.chapters[index]
      const content = chapters[index]?.content ?? ''
      emit(options, {
        phase: 'analyze',
        message: `正在分析《${chapter.title}》`,
        chapterIndex: i + 1,
        chapterTotal: indexes.length,
      })
      const result = await analyzeChapter(agent, chapter.title, content, options.signal)
      if (result.fatal) {
        ActionLog.error('style-analyze', {
          sourceId,
          model: agent.model,
          detail: result.detail,
        })
        throw new Error(result.error ?? '文风分析模型调用失败')
      }
      const record: SampleRecord = {
        index,
        title: chapter.title,
        chars: chapter.charCount,
        analysis: result.analysis,
        failed: !result.analysis,
      }
      records.push(record)
      if (!result.analysis) {
        failures.push({ title: chapter.title, error: result.error ?? '模型未返回内容' })
        ActionLog.warn('style-analyze', {
          sourceId,
          title: chapter.title,
          error: result.error,
          detail: result.detail,
        })
      }
      sampleFile.records = records
      await writeSampleFile(sourceId, sampleFile)
    }

    const okCount = records.filter((r) => r.analysis).length
    if (!okCount) {
      // 全部失败时不保存 0% 画像，否则界面会把“没有结果”误呈成“分析完成”
      throw new Error(
        failures.length
          ? `所有抽样章节都未能完成分析。${failures[failures.length - 1].error}`
          : '模型未能返回有效的文风分析结果，请检查文风分析模型的配置后重试',
      )
    }
    if (failures.length) {
      ActionLog.warn('style-analyze', `${failures.length}/${records.length} 章分析失败，已用其余章节生成画像`)
      emit(options, {
        phase: 'aggregate',
        message: `部分章节分析失败（${failures.length}/${records.length}），已用其余章节生成画像`,
      })
    }
    sampleFile.complete = true
    sampleFile.records = records
    await writeSampleFile(sourceId, sampleFile)
  } catch (e) {
    const err = e as Error
    if (err?.name === 'AbortError') {
      await updateStyleSourceStatus(sourceId, source.status)
      throw err
    }
    await updateStyleSourceStatus(sourceId, 'failed')
    ActionLog.error('style-analyze', { sourceId, model: agent.model, error: err?.message })
    throw err
  }

  emit(options, { phase: 'aggregate', message: '正在聚合成画像…' })
  const sampledChars = records.reduce((sum, r) => sum + r.chars, 0)
  const coverage = indexes.length ? records.filter((r) => r.analysis).length / indexes.length : 0
  const sampleStats: StyleSampleStats = {
    totalChapters: manifest.chapters.length,
    sampledChapters: indexes.length,
    sampledChars,
    model: agent.model,
    promptVersion: STYLE_PROMPT_VERSION,
  }
  const allEntities = aggregateEntities(records, 200)
  const sourceEntities = allEntities.slice(0, 20)
  // 标题工程依赖实体名：拿到人名后再回填“标题含角色名”的比例
  const titleMetrics = computeTitleMetrics(
    manifest.chapters.map((chapter) => chapter.title),
    sourceEntities,
  )
  axes.titleNamePct = titleMetrics.namePct
  axes.titleExclaimPct = titleMetrics.exclaimPct
  axes.titleQuestionPct = titleMetrics.questionPct
  axes.titleMultiPartPct = titleMetrics.multiPartPct

  // 脱敏用完整实体表：只存前 20 个，但证据里出现的次要角色名也要替换
  const craft = redactCraftNames(aggregateCraft(records), allEntities)
  if (craft) axes.characterVoiceDispersion = voiceDispersion(craft.voices)

  const payload: StyleProfileData = {
    schemaVersion: '2.0',
    metricVersion: STYLE_METRIC_VERSION,
    summary: buildSummary(records),
    axes,
    categorical: aggregateCategorical(records),
    dimensions: aggregateDimensions(records),
    rules: aggregateRules(records),
    lexicon: aggregateLexicon(records),
    sourceEntities,
    sampleStats,
    confidence: confidenceOf(records, coverage),
    ...(craft ? { craft } : {}),
  }

  const previous = await listStyleProfiles(sourceId)
  const profileId = newStyleProfileId()
  const profile: StyleProfile = {
    id: profileId,
    sourceId,
    version: (previous[0]?.version ?? 0) + 1,
    status: 'draft',
    confidence: payload.confidence,
    model: agent.model,
    promptVersion: STYLE_PROMPT_VERSION,
    contentHash: manifest.contentHash,
    payload,
    metrics: { axes, sampled: records.map((r) => ({ index: r.index, title: r.title, failed: !!r.failed })) },
    sampleStats,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  emit(options, { phase: 'save', message: '正在保存画像草稿…' })
  await saveStyleProfile(profile)
  const anchors = buildAnchors(profileId, records, chapters)
  await replaceStyleAnchors(profileId, anchors)
  await updateStyleSourceStatus(sourceId, 'ready')
  ActionLog.agent('文风画像生成', {
    sourceId,
    version: profile.version,
    confidence: profile.confidence,
    sampled: indexes.length,
    anchors: anchors.length,
  })
  emit(options, { phase: 'done', message: `画像 v${profile.version} 已生成，请审阅后启用` })
  return profile
}

/** 重新分析：生成新版本，不覆盖旧画像。 */
export async function reanalyzeStyleSource(sourceId: string, options: AnalyzeStyleOptions = {}): Promise<StyleProfile> {
  return analyzeStyleSource(sourceId, options)
}

export interface ImportStyleSourceInput {
  kind: StyleSourceKind
  path?: string
  text?: string
  name?: string
  preview?: { chapterCount: number; charCount: number; contentHash: string }
}

/** 导入语料：主进程规范化落盘，渲染层登记来源行。 */
export async function importStyleSource(input: ImportStyleSourceInput): Promise<StyleSourceRow> {
  const { newStyleSourceId, saveStyleSource, getStyleSource } = await import('./style-service')
  const sourceId = newStyleSourceId()
  const manifest = (await window.electronAPI.corpus.import({
    sourceId,
    name: input.name || '未命名语料',
    path: input.path,
    kind: input.kind,
    text: input.text,
  })) as CorpusManifest
  const now = new Date().toISOString()
  const source = {
    id: sourceId,
    name: manifest.name,
    kind: input.kind,
    originPath: manifest.originPath,
    chapterCount: manifest.chapters.length,
    charCount: manifest.totalChars,
    contentHash: manifest.contentHash,
    manifestPath: `content/styles/${sourceId}/manifest.json`,
    status: 'imported' as const,
    createdAt: now,
    updatedAt: now,
  }
  await saveStyleSource(source)
  return (await getStyleSource(sourceId)) ?? source
}

type StyleSourceRow = Awaited<ReturnType<typeof getStyleSource>> extends infer T ? Exclude<T, null> : never

/** 最新 ready 画像的统计口径（供 UI 展示）。 */
export async function profileStatusLabel(sourceId: string): Promise<string> {
  const profile = await latestStyleProfile(sourceId)
  if (!profile) return '未分析'
  return `v${profile.version} · ${profile.status} · 置信度 ${(profile.confidence * 100).toFixed(0)}%`
}
