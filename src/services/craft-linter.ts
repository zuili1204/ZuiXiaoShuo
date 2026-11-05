// 叙事工程层体检（Craft Linter）：结构/角色声音/钩子/禁忌四项，与表达层分开计分。
// 每项低分必须能落到一句可执行修法，避免“像不像”只剩一个没有下文的数字。
import type {
  CraftEvalDimension,
  StyleAxes,
  StyleCraftData,
  StyleEvalFinding,
} from '@shared/style-types'
import type { StyleMetrics } from '@shared/style-metrics'

export interface CraftLintInput {
  metrics: StyleMetrics
  /** 本书融合后的目标轴 */
  target: StyleAxes
  craft?: StyleCraftData
  title?: string
  entityNames?: string[]
}

export interface CraftLintResult {
  score: number
  dimensions: CraftEvalDimension[]
  findings: StyleEvalFinding[]
}

interface DimensionCheck {
  key: string
  label: string
  weight: number
  score: number
  detail: string
  fix?: string
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function adherence(actual: number, target: number, tolerance: number): number {
  if (tolerance <= 0) return actual === target ? 1 : 0
  return clamp01(1 - Math.abs(actual - target) / tolerance)
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

function checkStructure(input: CraftLintInput): DimensionCheck {
  const { metrics, target, title, entityNames = [] } = input
  let score = 100
  const fixes: string[] = []
  const parts: string[] = []

  const inScene = metrics.openingType === 'dialogue' || metrics.openingType === 'continuation'
  parts.push(`开篇 ${inScene ? '直接进场景' : '未直接进场景'}`)
  if (target.openingInMediaResPct >= 50 && !inScene) {
    score -= 30
    fixes.push('开篇从环境或概括起笔，作者更常用动作/对话直接进场景：第一句就让角色开口或做一个具体动作')
  }

  if (target.endingMedianLen > 0) {
    const diff = Math.abs(metrics.endingLen - target.endingMedianLen)
    parts.push(`章末 ${Math.round(metrics.endingLen)} 字`)
    if (diff > Math.max(25, target.endingMedianLen)) {
      score -= 20
      fixes.push(
        `章末句 ${Math.round(metrics.endingLen)} 字，作者中位 ${Math.round(target.endingMedianLen)} 字：停在更短的一个画面或一句台词上`,
      )
    }
  }
  if (target.endingShortImagePct >= 40 && metrics.endingType !== 'image' && metrics.endingType !== 'dialogue') {
    score -= 15
    fixes.push('章末不是短画面/台词：删掉总结句，最后一句只留动作、物件或对话')
  }

  if (title && entityNames.length && target.titleNamePct >= 30) {
    const hasName = entityNames.some((name) => name.trim().length >= 2 && title.includes(name))
    if (!hasName) {
      score -= 10
      fixes.push('标题里没有角色名，作者常用“角色名 + 事件”命名：把标题改成能看出是谁的这场戏')
    }
  }

  return {
    key: 'structure',
    label: '结构像',
    weight: 0.3,
    score: Math.max(0, score),
    detail: parts.join('；'),
    fix: fixes[0],
  }
}

function checkCharacter(input: CraftLintInput): DimensionCheck {
  const { metrics, target, craft } = input
  const voiceLens = (craft?.voices ?? []).map((v) => v.sentenceAvgLen).filter((n) => n > 0)
  const expected = voiceLens.length ? mean(voiceLens) : target.dialogueAvgLen
  if (!metrics.dialogueCount || !expected) {
    return { key: 'character', label: '角色像', weight: 0.2, score: 100, detail: '本章没有对话，跳过角色声音比对' }
  }
  const adh = adherence(metrics.dialogueAvgLen, expected, Math.max(6, expected * 0.5))
  const score = Math.round(adh * 100)
  return {
    key: 'character',
    label: '角色像',
    weight: 0.2,
    score,
    detail: `对话句均 ${Math.round(metrics.dialogueAvgLen)} 字，作者角色约 ${Math.round(expected)} 字`,
    fix:
      score < 50
        ? `对话句均 ${Math.round(metrics.dialogueAvgLen)} 字，作者角色约 ${Math.round(expected)} 字：把长句解释拆成短句对答，保留口头禅`
        : undefined,
  }
}

function checkHook(input: CraftLintInput): DimensionCheck {
  const { metrics, target } = input
  const hookAdherence = adherence(metrics.hookEnding ? 100 : 0, target.hookEndingPct, Math.max(50, target.hookEndingPct))
  const questionAdherence = target.questionPerChapter
    ? adherence(metrics.questionCount, target.questionPerChapter, Math.max(2, target.questionPerChapter))
    : 1
  const ellipsisAdherence = target.ellipsisPerChapter
    ? adherence(metrics.ellipsisCount, target.ellipsisPerChapter, Math.max(2, target.ellipsisPerChapter))
    : 1
  const score = Math.round((hookAdherence * 0.6 + questionAdherence * 0.2 + ellipsisAdherence * 0.2) * 100)
  const fixes: string[] = []
  if (hookAdherence < 0.5 && target.hookEndingPct >= 50) {
    fixes.push('章末没有留钩：最后一句改成未完成动作、突然出现的信息或一句没答完的话')
  }
  if (questionAdherence < 0.5) {
    fixes.push(`问号 ${metrics.questionCount} 处，作者每章约 ${Math.round(target.questionPerChapter)} 处：用角色追问替代叙述解释`)
  }
  if (ellipsisAdherence < 0.5) {
    fixes.push(`省略号 ${metrics.ellipsisCount} 处，作者每章约 ${Math.round(target.ellipsisPerChapter)} 处：留白不足，删掉把话说尽的句子`)
  }
  return {
    key: 'hook',
    label: '钩子像',
    weight: 0.25,
    score,
    detail: `章末${metrics.hookEnding ? '有钩' : '无钩'}；问号 ${metrics.questionCount}，省略号 ${metrics.ellipsisCount}`,
    fix: fixes[0],
  }
}

function checkTaboo(input: CraftLintInput): DimensionCheck {
  const { metrics, target, craft } = input
  const authorTaboos = craft?.taboos ?? []
  const strict = target.tabooRatio < 0.2 || authorTaboos.length > 0
  if (!strict) {
    return { key: 'taboo', label: '禁忌像', weight: 0.25, score: 100, detail: '作者本身使用苦情/代价模板，不设禁忌' }
  }
  const hits = metrics.tabooHits
  const score = hits ? Math.max(0, 100 - hits * 25) : 100
  return {
    key: 'taboo',
    label: '禁忌像',
    weight: 0.25,
    score,
    detail: hits
      ? `出现 ${hits} 处“代价/宿命/倒计时”式模板`
      : '未触碰作者回避的苦情/闭环模板',
    fix: hits
      ? '出现“代价是/宿命/倒计时”式苦情模板：改成可恢复、可控的日常风险，或只留喜剧性后果'
      : undefined,
  }
}

/** 四项加权（结构 0.3 / 角色 0.2 / 钩子 0.25 / 禁忌 0.25）。 */
export function lintCraft(input: CraftLintInput): CraftLintResult {
  const checks = [checkStructure(input), checkCharacter(input), checkHook(input), checkTaboo(input)]
  const score = Math.round(checks.reduce((sum, c) => sum + c.score * c.weight, 0))
  const dimensions: CraftEvalDimension[] = checks.map((c) => ({
    key: c.key,
    label: c.label,
    score: c.score,
    detail: c.detail,
  }))
  const findings: StyleEvalFinding[] = checks
    .filter((c) => c.fix)
    .map((c) => ({
      dimension: c.label,
      severity: 'advisory' as const,
      message: c.fix as string,
    }))
  return { score, dimensions, findings }
}
