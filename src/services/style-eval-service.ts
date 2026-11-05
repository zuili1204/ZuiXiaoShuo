/**
 * P2 生成后评估：文风 adherence、来源相似度与漂移提示。
 *
 * 风格分口径（规划 §10.5）：
 *   adherence = clamp(1 - |实际 - 目标| / 容差, 0, 1)
 *   styleScore = 0.6 × metricsScore + 0.4 × rubricScore（无 rubric 时 styleScore = metricsScore）
 * 相似度由主进程比对来源语料：12 字 n-gram / 最长公共子串 / 实体泄漏。
 */
import type {
  SimilarityReport,
  StyleEvalDimension,
  StyleEvalFinding,
  StyleEvalResult,
  StyleAxes,
} from '@shared/style-types'
import { computeStyleMetrics, metricsToAxes } from '@shared/style-metrics'
import { hashText } from '@shared/chapter-split'
import { loadMergedStyleForNovel } from './style-blend-service'
import { lintCraft } from './craft-linter'
import { saveEvalResultAsRun } from './style-service'
import { getAgent, callLLM, extractJson } from './ai-outline'

const api = () => window.electronAPI

export interface StyleEvalOptions {
  novelId: string
  chapterId: string
  content: string
  /** 章节标题：用于比对作者标题工程 */
  title?: string
  /** 追加一次 LLM 评分（0~100），缺省只用定量指标 */
  useRubric?: boolean
  signal?: AbortSignal
}

interface DimensionConfig {
  key: string
  label: string
  axis: keyof StyleAxes
  tolerance: number
  weight: number
}

/** 六个可量化维度，权重合计 1.0（syntax/dialogue/pacing 各 0.2）。 */
export const EVAL_DIMENSIONS: DimensionConfig[] = [
  { key: 'syntax', label: '句法节奏', axis: 'sentenceAvgLen', tolerance: 6, weight: 0.2 },
  { key: 'dialogue', label: '对话密度', axis: 'dialoguePct', tolerance: 8, weight: 0.2 },
  { key: 'pacing', label: '章末钩子', axis: 'hookEndingPct', tolerance: 50, weight: 0.2 },
  { key: 'description', label: '描写密度', axis: 'simileStrictPer1k', tolerance: 2, weight: 0.15 },
  { key: 'interiority', label: '心理描写', axis: 'interiorityPct', tolerance: 5, weight: 0.15 },
  { key: 'lexicon', label: '口语化', axis: 'colloquialPct', tolerance: 8, weight: 0.1 },
]

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function round(n: number, digits = 1): number {
  return +n.toFixed(digits)
}

export function adherenceOf(actual: number, target: number, tolerance: number): number {
  if (tolerance <= 0) return actual === target ? 1 : 0
  return clamp01(1 - Math.abs(actual - target) / tolerance)
}

export function scoreDimensions(actual: StyleAxes, target: StyleAxes): StyleEvalDimension[] {
  return EVAL_DIMENSIONS.map((d) => {
    const a = Number(actual[d.axis] ?? 0)
    const t = Number(target[d.axis] ?? 0)
    return {
      key: d.key,
      label: d.label,
      actual: round(a),
      target: round(t),
      tolerance: d.tolerance,
      adherence: round(adherenceOf(a, t, d.tolerance), 2),
      weight: d.weight,
    }
  })
}

export function weightedStyleScore(dimensions: StyleEvalDimension[]): number {
  const total = dimensions.reduce((s, d) => s + d.weight, 0) || 1
  const score = dimensions.reduce((s, d) => s + d.adherence * d.weight, 0) / total
  return Math.round(score * 100)
}

export function buildFindings(dimensions: StyleEvalDimension[], similarity: SimilarityReport): StyleEvalFinding[] {
  const findings: StyleEvalFinding[] = []
  for (const d of dimensions) {
    if (d.adherence >= 0.5) continue
    const direction = d.actual > d.target ? '偏高' : '偏低'
    findings.push({
      dimension: d.label,
      severity: 'advisory',
      message: `本章${d.label}${direction}：实际 ${d.actual}，目标 ${d.target}（容差 ${d.tolerance}）`,
    })
  }
  for (const hit of similarity.hits) {
    findings.push({ dimension: '来源相似度', severity: hit.severity, message: hit.detail })
  }
  return findings
}

const RUBRIC_PROMPT = (content: string, targetText: string) => `你是严格的文体评审。请只根据下面的“目标文风”和“本章正文”，从叙事口吻、句法节奏、对话质感、描写密度、情绪基调五个方面打分（0~100，100 表示完全贴合）。

只返回 JSON：{"score": 0-100, "notes": "不超过 80 字的简评"}

【目标文风】
${targetText}

【本章正文】
${content.slice(0, 8000)}`

async function rubricScore(content: string, targetText: string, novelId: string, signal?: AbortSignal): Promise<number | null> {
  if (!targetText.trim()) return null
  try {
    const agent = await getAgent()
    if (!agent) return null
    const raw = await callLLM(agent, novelId, RUBRIC_PROMPT(content, targetText), signal)
    const json = extractJson(raw)
    if (!json) return null
    const parsed = JSON.parse(json) as { score?: unknown }
    const score = Number(parsed.score)
    if (!Number.isFinite(score)) return null
    return Math.max(0, Math.min(100, Math.round(score)))
  } catch {
    return null
  }
}

/**
 * 评估一章文风。未绑定文风配方时返回 null（不产生噪音记录）。
 * 相似度检查失败时降级为空报告，风格分照常返回。
 */
export async function evaluateChapterStyle(options: StyleEvalOptions): Promise<StyleEvalResult | null> {
  const { novelId, chapterId, content } = options
  if (!novelId || !chapterId || !content.trim()) return null

  const merged = await loadMergedStyleForNovel(novelId)
  if (!merged) return null

  const metrics = computeStyleMetrics(content)
  const actual = metricsToAxes(metrics)
  const dimensions = scoreDimensions(actual, merged.axes)
  const metricsScore = weightedStyleScore(dimensions)
  const craftLint = lintCraft({
    metrics,
    target: merged.axes,
    craft: merged.craft,
    title: options.title,
    entityNames: merged.sourceEntities,
  })

  let similarity: SimilarityReport = { ngramRate: 0, longestCommon: 0, hits: [], blocking: 0, advisory: 0 }
  try {
    similarity = (await api().style.similarity({
      text: content,
      sourceIds: merged.mergedFrom.map((m) => m.sourceId),
      entities: merged.sourceEntities,
    })) as SimilarityReport
  } catch (e) {
    console.warn('[style-eval] similarity failed:', e)
  }

  const rubric = options.useRubric
    ? await rubricScore(content, merged.summary, novelId, options.signal)
    : null
  const styleScore =
    rubric == null ? metricsScore : Math.round(metricsScore * 0.6 + rubric * 0.4)
  // 综合“像不像你”：表达层 55% + 叙事工程层 45%
  const overallScore = Math.round(styleScore * 0.55 + craftLint.score * 0.45)

  return {
    styleScore,
    metricsScore,
    rubricScore: rubric,
    dimensions,
    findings: buildFindings(dimensions, similarity),
    similarity,
    overallScore,
    craftScore: craftLint.score,
    craftDimensions: craftLint.dimensions,
    craftFindings: craftLint.findings,
    recipeId: merged.recipeId,
    recipeName: merged.recipeName,
    createdAt: new Date().toISOString(),
  }
}

/** 评估并落库（追加式记录，便于对比漂移趋势）。 */
export async function evaluateAndSave(options: StyleEvalOptions & { model?: string }) {
  const result = await evaluateChapterStyle(options)
  if (!result) return null
  return saveEvalResultAsRun({
    novelId: options.novelId,
    chapterId: options.chapterId,
    chapterHash: hashText(options.content).slice(0, 16),
    result,
    model: options.model ?? '',
  })
}
