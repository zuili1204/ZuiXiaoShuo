/**
 * P3 三层章节评估的编排层（规划 §11.1）。
 *
 * 确定性层：质量门禁（标点/禁用词/复读/章末升华/引号）+ 连贯性规则 + 本地补充检查。
 * 模型辅助层：文风分（有配方时）+ 语义矛盾 / 人物声音一致性（LLM，可选）。
 * 人工层：由 feedback-service 单独记录作者接受/拒绝与批注，不在这里自动判定。
 *
 * 模型发现一律为 advisory，不参与阻断；只有确定性层可以产生 blocking。
 */
import type { Chapter, QualityFinding } from '@shared/types'
import type {
  ChapterEvalResult,
  ChapterEvalRun,
  DeterministicEvalResult,
  EvalFinding,
  ModelEvalResult,
} from '@shared/review-types'
import { hashText } from '@shared/chapter-split'
import { computeStyleMetrics } from '@shared/style-metrics'
import { computeHookStrength } from '@shared/review-metrics'
import { runQualityGate } from './quality-service'
import { CONTINUITY_RULES, type ContinuityFinding } from './continuity-checker'
import { checkChapterContinuity } from './story-check-service'
import { evaluateChapterStyle } from './style-eval-service'
import { characterService } from './data-service'
import { latestCharacterStates, listCharacterStates, listPlotThreads } from './story-state-service'
import { getAgent, callLLM, extractJson } from './ai-outline'

const api = () => window.electronAPI

const QUALITY_SOURCE_LABEL: Record<QualityFinding['source'], string> = {
  'ai-patterns': 'AI 句式',
  degeneration: '退化',
  'style-metrics': '文风硬伤',
}

const BANNED_WORDS = [
  '不禁', '不由得', '缓缓', '淡淡地', '嘴角勾起', '眼中闪过一丝',
  '心中一凛', '若有所思', '嘴角微微上扬',
]
const SUBLIME_CUE = /(或许|终究|也许|人生|命运|这一刻|从此|意义|值得|仿佛在说|无声地)/
const STRAIGHT_QUOTE = /"/
const PUNCT_STACK = /[！!？?]{2,}|。{2,}|…{4,}/g

export interface ChapterEvalOptions {
  novelId: string
  chapter: Chapter
  content: string
  /** 请求 LLM 做语义矛盾 / 人物声音检查 */
  useModel?: boolean
  signal?: AbortSignal
}

interface LocalCheckInput {
  content: string
  targetWordCount: number
  hooks: string[]
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function round(n: number): number {
  return Math.round(n)
}

function paragraphList(content: string): { text: string; line: number }[] {
  return content
    .split(/\r?\n/)
    .map((text, i) => ({ text: text.trim(), line: i + 1 }))
    .filter((p) => p.text.length > 0)
}

/** 本地补充检查：覆盖脚本不可用（浏览器/测试）时的硬伤与提示。 */
export function runLocalDeterministicChecks(input: LocalCheckInput): EvalFinding[] {
  const findings: EvalFinding[] = []
  const metrics = computeStyleMetrics(input.content)
  const paragraphs = paragraphList(input.content)
  const add = (f: Omit<EvalFinding, 'layer'>) => findings.push({ layer: 'deterministic', ...f })

  const openCurly = (input.content.match(/“/g) || []).length
  const closeCurly = (input.content.match(/”/g) || []).length
  const openCorner = (input.content.match(/「/g) || []).length
  const closeCorner = (input.content.match(/」/g) || []).length
  if (openCurly !== closeCurly) {
    add({
      ruleId: 'quote-balance',
      label: '引号闭合',
      severity: 'blocking',
      message: `弯引号未成对：左 ${openCurly} 个、右 ${closeCurly} 个`,
      suggestion: '补齐或删除缺失的引号后再发布。',
    })
  }
  if (openCorner !== closeCorner) {
    add({
      ruleId: 'quote-balance',
      label: '引号闭合',
      severity: 'blocking',
      message: `直角引号未成对：左 ${openCorner} 个、右 ${closeCorner} 个`,
      suggestion: '补齐或删除缺失的引号后再发布。',
    })
  }
  if (STRAIGHT_QUOTE.test(input.content)) {
    add({
      ruleId: 'straight-quote',
      label: '引号规范',
      severity: 'warning',
      message: '正文仍有英文直引号',
      suggestion: '统一替换为中文弯引号。',
    })
  }

  const bannedHits = BANNED_WORDS.filter((w) => input.content.includes(w))
  if (bannedHits.length) {
    add({
      ruleId: 'banned-words',
      label: '套话',
      severity: 'advisory',
      message: `命中 ${bannedHits.length} 个常见套话：${bannedHits.slice(0, 6).join('、')}`,
      suggestion: '能删就删；需要保留时换成具体动作或感官细节。',
    })
  }

  const punctHits = (input.content.match(PUNCT_STACK) || []).length
  if (punctHits > 0) {
    add({
      ruleId: 'punctuation-stack',
      label: '标点堆叠',
      severity: 'warning',
      message: `连续标点 ${punctHits} 处`,
      suggestion: '保留一个最强标点即可，连续感叹号/省略号会削弱力度。',
    })
  }

  // 复读：同一句（≥10 字）在文中出现 3 次以上
  const sentenceCount = new Map<string, number>()
  for (const s of input.content.split(/[。！？!?…\n]/).map((x) => x.trim()).filter((x) => x.length >= 10)) {
    sentenceCount.set(s, (sentenceCount.get(s) ?? 0) + 1)
  }
  const repeated = [...sentenceCount.entries()].filter(([, n]) => n >= 3)
  if (repeated.length) {
    add({
      ruleId: 'repetition',
      label: '复读',
      severity: 'warning',
      message: `有 ${repeated.length} 句重复出现 3 次以上`,
      suggestion: '合并或改写重复句，避免读者跳读。',
      evidence: repeated[0][0].slice(0, 60),
    })
  }

  // 章末升华：最后一段是总结/感慨而不是动作或悬念
  const last = paragraphs[paragraphs.length - 1]
  if (last && last.text.length >= 10 && SUBLIME_CUE.test(last.text) && !/[“”"「」]/.test(last.text)) {
    add({
      ruleId: 'chapter-end-sublime',
      label: '章末升华',
      severity: 'advisory',
      message: '章末以总结/感慨收尾',
      suggestion: '改成具体动作、新问题或反转，把余味留给读者自己判断。',
      location: `第 ${last.line} 行`,
      evidence: last.text.slice(0, 60),
    })
  }

  const hook = computeHookStrength(input.content)
  if (metrics.chars > 300 && !hook.chapterEndHook) {
    add({
      ruleId: 'chapter-end-hook',
      label: '章末钩子',
      severity: 'advisory',
      message: '章末没有提问、反转或新问题',
      suggestion: '把最后 3 行改成新决定/新问题/反转，给读者翻页理由。',
    })
  }

  if (input.hooks.length === 0 && metrics.chars > 0) {
    add({
      ruleId: 'hooks-missing',
      label: '细纲钩子',
      severity: 'advisory',
      message: '本章没有设置细纲 hooks',
      suggestion: '在场景卡或章节细纲里补 1~2 个本章必须兑现的点。',
    })
  }

  if (input.targetWordCount > 0 && metrics.chars < input.targetWordCount * 0.6) {
    add({
      ruleId: 'word-count',
      label: '字数',
      severity: 'warning',
      message: `本章 ${metrics.chars} 字，目标 ${input.targetWordCount} 字`,
      suggestion: '补足关键场景的冲突与反应，不要靠重复描写灌水。',
    })
  }

  return findings
}

function mapQualityFinding(f: QualityFinding): EvalFinding {
  return {
    layer: 'deterministic',
    ruleId: `quality-${f.source}`,
    label: QUALITY_SOURCE_LABEL[f.source] ?? f.source,
    severity: f.severity === 'blocking' ? 'blocking' : 'warning',
    message: f.type ? `[${f.type}] ${f.message}` : f.message,
    location: f.line > 0 ? `第 ${f.line} 行` : undefined,
    evidence: f.excerpt || undefined,
  }
}

function mapContinuityFinding(f: ContinuityFinding): EvalFinding {
  const meta = CONTINUITY_RULES.find((r) => r.id === f.ruleId)
  return {
    layer: 'deterministic',
    ruleId: `continuity-${f.ruleId}`,
    label: meta?.label ?? f.ruleId,
    severity: f.severity === 'blocking' ? 'blocking' : 'warning',
    message: f.message,
    suggestion: f.suggestion,
    location: f.location,
    evidence: f.evidence,
  }
}

export function scoreDeterministic(findings: EvalFinding[], qualityScore: number): DeterministicEvalResult {
  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  // 质量分已覆盖 quality-* 发现，这里只对连贯性/本地补充扣分，避免重复计数
  const extraBlocking = findings.filter((f) => f.severity === 'blocking' && !f.ruleId.startsWith('quality-')).length
  const extraWarnings = findings.filter((f) => f.severity === 'warning' && !f.ruleId.startsWith('quality-')).length
  const extraAdvisories = findings.filter((f) => f.severity === 'advisory' && !f.ruleId.startsWith('quality-')).length
  const extraScore = clamp(100 - extraBlocking * 20 - extraWarnings * 5 - extraAdvisories * 2, 0, 100)
  const score = round(clamp(qualityScore * 0.6 + extraScore * 0.4, 0, 100))

  return {
    score,
    blocking,
    warnings,
    wordCount: 0,
    targetWordCount: 0,
    chapterEndHook: false,
    qualityScore,
    findings,
  }
}

interface SemanticJson {
  findings?: { category?: unknown; severity?: unknown; message?: unknown; suggestion?: unknown; location?: unknown }[]
  suggestions?: unknown
  notes?: unknown
}

const CATEGORY_LABEL: Record<string, string> = {
  contradiction: '语义矛盾',
  voice: '人物声音',
  logic: '情节逻辑',
}

function buildStateContext(
  states: ReturnType<typeof latestCharacterStates>,
  names: Map<string, string>,
  threads: { title: string; status: string; payoffPlan: string }[]
): string {
  const stateLines = states.slice(0, 10).map((s) => {
    const name = names.get(s.characterId) ?? s.characterId
    const knowledge = s.knowledge.knows.slice(0, 4).join('、') || '无'
    const items = s.items.map((i) => i.name).slice(0, 4).join('、') || '无'
    const abilities = s.abilities.map((a) => a.name).slice(0, 4).join('、') || '无'
    return `- ${name}：位置=${s.location || '未记录'}；状态=${s.status}；已知=${knowledge}；持有=${items}；能力=${abilities}`
  })
  const threadLines = threads
    .slice(0, 8)
    .map((t) => `- 《${t.title}》（${t.status}）${t.payoffPlan ? `：${t.payoffPlan}` : ''}`)
  return `【角色状态】\n${stateLines.join('\n') || '（暂无状态记录）'}\n【未回收剧情线】\n${threadLines.join('\n') || '（暂无）'}`
}

const SEMANTIC_PROMPT = (
  content: string,
  hooks: string[],
  context: string
) => `你是小说编辑，任务不是改稿，而是找出“模型读者会注意到的理解障碍”。只根据给定正文与状态记录判断，不要编造设定。

检查三类问题：
1. contradiction：正文与角色状态/剧情线矛盾（例如死者出场、已知信息倒流）。
2. voice：主要人物说话方式与前文/身份不一致。
3. logic：因果、时间顺序或动机断裂。

要求：每类最多 2 条，只报高置信问题；没有就返回空数组。只返回 JSON：
{"findings":[{"category":"contradiction|voice|logic","severity":"warning|advisory","message":"不超过 60 字","suggestion":"可执行的一句话","location":"第 N 段"}],"suggestions":["不超过 3 条可执行建议"],"notes":"不超过 80 字总评"}

【本章细纲】
${hooks.length ? hooks.map((h) => `- ${h}`).join('\n') : '（未设置）'}

${context}

【本章正文】
${content.slice(0, 8000)}`

async function runSemanticReview(
  novelId: string,
  chapterOrder: number,
  content: string,
  hooks: string[],
  signal?: AbortSignal
): Promise<{ ok: boolean; findings: EvalFinding[]; suggestions: string[]; notes: string }> {
  try {
    const agent = await getAgent()
    if (!agent) return { ok: false, findings: [], suggestions: [], notes: '' }

    const [states, threads, characters] = await Promise.all([
      listCharacterStates(novelId),
      listPlotThreads(novelId),
      characterService.getByNovelId(novelId),
    ])
    const latest = latestCharacterStates(states, chapterOrder)
    const names = new Map(characters.map((c) => [c.id, c.name]))
    const openThreads = threads.filter((t) => t.status !== 'resolved' && t.status !== 'abandoned')
    const raw = await callLLM(
      agent,
      novelId,
      SEMANTIC_PROMPT(content, hooks, buildStateContext(latest, names, openThreads)),
      signal
    )
    const json = extractJson(raw)
    if (!json) return { ok: false, findings: [], suggestions: [], notes: '' }
    const parsed = JSON.parse(json) as SemanticJson
    const findings: EvalFinding[] = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f) => f && typeof f.message === 'string')
      .slice(0, 6)
      .map((f) => {
        const category = typeof f.category === 'string' ? f.category : 'logic'
        return {
          layer: 'model' as const,
          ruleId: `model-${category}`,
          label: CATEGORY_LABEL[category] ?? '模型提示',
          severity: 'advisory' as const,
          message: String(f.message).slice(0, 160),
          suggestion: typeof f.suggestion === 'string' ? f.suggestion.slice(0, 160) : undefined,
          location: typeof f.location === 'string' ? f.location.slice(0, 40) : undefined,
        }
      })
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 4)
      : []
    return {
      ok: true,
      findings,
      suggestions,
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : '',
    }
  } catch (e) {
    console.warn('[chapter-eval] semantic review failed:', e)
    return { ok: false, findings: [], suggestions: [], notes: '' }
  }
}

function buildDeterministicSuggestions(
  det: DeterministicEvalResult,
  targetWordCount: number
): string[] {
  const out: string[] = []
  const blocking = det.findings.filter((f) => f.severity === 'blocking')
  for (const f of blocking.slice(0, 2)) {
    out.push(`先处理${f.label}：${f.suggestion || f.message}`)
  }
  if (!det.chapterEndHook) {
    out.push('章末补一个钩子：让最后一段落到新问题、新决定或反转上。')
  }
  if (targetWordCount > 0 && det.wordCount < targetWordCount * 0.6) {
    out.push(`本章 ${det.wordCount} 字，目标 ${targetWordCount} 字：优先补关键冲突，而不是拉长描写。`)
  }
  for (const f of det.findings.filter((x) => x.severity === 'warning' && x.suggestion).slice(0, 2)) {
    out.push(`${f.label}：${f.suggestion}`)
  }
  if (out.length < 3) {
    out.push('把本章“开篇状态”和“章末状态”各写一句，确认主角至少有一个可见变化。')
  }
  if (out.length < 3) {
    out.push('检查每段是否都有推进：只保留目标、阻碍、转折、结果四类内容。')
  }
  return [...new Set(out)].slice(0, 6)
}

export async function evaluateChapter(options: ChapterEvalOptions): Promise<ChapterEvalResult> {
  const { novelId, chapter, content } = options
  const hooks = chapter.hooks ?? []
  const targetWordCount = chapter.targetWordCount ?? 0

  const [quality, continuity] = await Promise.all([
    runQualityGate(content),
    checkChapterContinuity({
      novelId,
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      hooks,
      content,
    }).catch((e) => {
      console.warn('[chapter-eval] continuity failed:', e)
      return [] as ContinuityFinding[]
    }),
  ])

  const local = runLocalDeterministicChecks({ content, targetWordCount, hooks })
  const findings: EvalFinding[] = [
    ...(quality.findings ?? []).map(mapQualityFinding),
    ...continuity.map(mapContinuityFinding),
    ...local,
  ]
  const deterministic = scoreDeterministic(findings, quality.score)
  const metrics = computeStyleMetrics(content)
  deterministic.wordCount = metrics.chars
  deterministic.targetWordCount = targetWordCount
  deterministic.chapterEndHook = computeHookStrength(content).chapterEndHook

  let styleScore: number | null = null
  try {
    const style = await evaluateChapterStyle({
      novelId,
      chapterId: chapter.id,
      content,
      title: chapter.title,
      useRubric: false,
      signal: options.signal,
    })
    // 综合分含表达层与叙事工程层；旧画像没有 craft 时退回表达分
    styleScore = style ? (style.overallScore ?? style.styleScore) : null
  } catch (e) {
    console.warn('[chapter-eval] style eval failed:', e)
  }

  const semantic = options.useModel
    ? await runSemanticReview(novelId, chapter.order, content, hooks, options.signal)
    : { ok: false, findings: [], suggestions: [], notes: '' }

  const voiceCount = semantic.findings.filter((f) => f.ruleId === 'model-voice').length
  const semanticScore = semantic.ok
    ? clamp(100 - semantic.findings.reduce((acc, f) => acc + (f.ruleId === 'model-contradiction' ? 12 : 6), 0), 0, 100)
    : null
  const voiceScore = semantic.ok ? clamp(100 - voiceCount * 15, 0, 100) : null
  const modelScore =
    semantic.ok
      ? styleScore != null
        ? round(styleScore * 0.5 + (semanticScore ?? 0) * 0.3 + (voiceScore ?? 0) * 0.2)
        : round((semanticScore ?? 0) * 0.6 + (voiceScore ?? 0) * 0.4)
      : null

  const model: ModelEvalResult = {
    attempted: !!options.useModel,
    available: semantic.ok,
    styleScore,
    semanticScore,
    voiceScore,
    findings: semantic.findings,
    suggestions: semantic.suggestions,
    notes: semantic.ok
      ? semantic.notes
      : options.useModel
        ? '未配置可用模型，本次只运行确定性层。'
        : '未启用模型辅助，本次只运行确定性层。',
  }

  const overallScore =
    modelScore != null ? round(deterministic.score * 0.6 + modelScore * 0.4) : deterministic.score

  const suggestions = [
    ...new Set([
      ...buildDeterministicSuggestions(deterministic, targetWordCount),
      ...semantic.suggestions,
    ]),
  ].slice(0, 6)

  return {
    overallScore,
    deterministicScore: deterministic.score,
    modelScore,
    styleScore,
    deterministic,
    model,
    suggestions,
    createdAt: new Date().toISOString(),
  }
}

// ===== 落库 =====

function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const DEFAULT_DETERMINISTIC: DeterministicEvalResult = {
  score: 0, blocking: 0, warnings: 0, wordCount: 0, targetWordCount: 0,
  chapterEndHook: false, qualityScore: 0, findings: [],
}

const DEFAULT_MODEL_RESULT: ModelEvalResult = {
  attempted: false, available: false, styleScore: null, semanticScore: null,
  voiceScore: null, findings: [], suggestions: [], notes: '',
}

function rowToEvalRun(row: any): ChapterEvalRun {
  const modelResult = safeParse<ModelEvalResult>(row.model_json, DEFAULT_MODEL_RESULT)
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    chapterHash: row.chapter_hash ?? '',
    overallScore: Number(row.overall_score) || 0,
    deterministicScore: Number(row.deterministic_score) || 0,
    modelScore: row.model_score == null ? null : Number(row.model_score),
    styleScore: row.style_score == null ? null : Number(row.style_score),
    deterministic: safeParse<DeterministicEvalResult>(row.deterministic_json, DEFAULT_DETERMINISTIC),
    model: modelResult,
    suggestions: safeParse<string[]>(row.suggestions_json, []),
    modelName: row.model ?? '',
    createdAt: row.created_at,
  }
}

export async function saveChapterEvalRun(
  novelId: string,
  chapterId: string,
  content: string,
  result: ChapterEvalResult
): Promise<ChapterEvalRun> {
  const run: ChapterEvalRun = {
    ...result,
    id: `cer_${crypto.randomUUID()}`,
    novelId,
    chapterId,
    chapterHash: hashText(content).slice(0, 16),
    modelName: '',
  }
  await api().db.query(
    `INSERT INTO chapter_eval_runs
      (id, novel_id, chapter_id, chapter_hash, overall_score, deterministic_score, model_score, style_score, deterministic_json, model_json, suggestions_json, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      novelId,
      chapterId,
      run.chapterHash,
      run.overallScore,
      run.deterministicScore,
      run.modelScore,
      run.styleScore,
      JSON.stringify(run.deterministic),
      JSON.stringify(run.model),
      JSON.stringify(run.suggestions),
      run.modelName,
      run.createdAt,
    ]
  )
  return run
}

export async function evaluateAndSaveChapter(
  options: ChapterEvalOptions
): Promise<ChapterEvalRun> {
  const result = await evaluateChapter(options)
  return saveChapterEvalRun(options.novelId, options.chapter.id, options.content, result)
}

export async function listChapterEvalRuns(chapterId: string, limit = 10): Promise<ChapterEvalRun[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM chapter_eval_runs WHERE chapter_id = ? ORDER BY created_at DESC LIMIT ?',
      [chapterId, limit]
    )) as any[]
    return rows.map(rowToEvalRun)
  } catch (e) {
    console.error('[chapter-eval] list runs failed:', e)
    return []
  }
}

export async function getLatestChapterEvalRun(chapterId: string): Promise<ChapterEvalRun | null> {
  const rows = await listChapterEvalRuns(chapterId, 1)
  return rows[0] ?? null
}
