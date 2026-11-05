// P2 多书融合：把配方引用的多份画像按来源权重/维度覆盖合成一份 MergedStyleProfile。
// 纯函数 blendStyles 可单测；loadMergedStyleForNovel 负责取数（绑定 → 配方 → 画像 → 锚点）。
import type {
  MergedStyleProfile,
  StyleAnchor,
  StyleAnchorKind,
  StyleAxes,
  StyleCategorical,
  StyleConflict,
  StyleDimension,
  StyleDimensionKey,
  StyleLexicon,
  StyleProfile,
  StyleRecipe,
  StyleRule,
  StyleTense,
  StylePov,
} from '@shared/style-types'
import { mergeStyleCraft } from '@shared/style-craft'
import {
  getStyleBinding,
  getStyleProfile,
  getStyleRecipe,
  listStyleAnchors,
  getStyleSource,
} from './style-service'

export interface BlendSourceInput {
  sourceId: string
  name: string
  profile: StyleProfile
  anchors: StyleAnchor[]
}

const DIMENSION_AXES: Record<StyleDimensionKey, (keyof StyleAxes)[]> = {
  pov_tense: [],
  syntax: ['sentenceAvgLen', 'shortSentencePct', 'longSentencePct', 'paragraphAvgLen', 'shortParagraphPct', 'parentheticalPerChapter'],
  lexicon: ['colloquialPct'],
  dialogue: ['dialoguePct', 'dialogueAvgLen', 'shortReplyPct'],
  description: ['simileStrictPer1k', 'sensoryPer1k'],
  interiority: ['interiorityPct'],
  humor_tone: [],
  characterization: [],
  pacing_hooks: ['hookEndingPct', 'infoHookPer1k', 'dashPerChapter'],
  // 叙事工程层：结构指标各自归属一个维度，避免与表达层争用同一根轴
  chapter_engineering: [
    'openingDialoguePct',
    'openingContinuationPct',
    'openingInMediaResPct',
    'endingMedianLen',
    'endingShortImagePct',
    'titleNamePct',
    'titleExclaimPct',
    'titleQuestionPct',
    'titleMultiPartPct',
  ],
  hook_design: ['questionPerChapter', 'ellipsisPerChapter', 'exclaimPerChapter'],
  relationship_engine: ['resetPerVolume'],
  setting_function: ['publicEventPerChapter'],
  meta_humor: [],
  concreteness: ['concreteObjectPer1k', 'explanationPer1k'],
  taboo_boundary: ['tabooRatio'],
  character_voice: ['characterVoiceDispersion'],
}

const AXIS_TO_DIMENSION: Partial<Record<keyof StyleAxes, StyleDimensionKey>> = (() => {
  const map: Partial<Record<keyof StyleAxes, StyleDimensionKey>> = {}
  for (const [dim, axes] of Object.entries(DIMENSION_AXES) as [StyleDimensionKey, (keyof StyleAxes)[]][]) {
    for (const axis of axes) map[axis] = dim
  }
  return map
})()

const RULE_TIER_MUST = 0.6
const RULE_TIER_SHOULD = 0.3
const MAX_RULES = 14
const MAX_ANCHORS = 4
const ANCHOR_ITEM_MAX = 160

const POV_LABEL: Record<StylePov, string> = {
  first: '第一人称',
  third_limited: '第三人称限知',
  third_omniscient: '第三人称全知',
  mixed: '人称混用',
  unknown: '未判定',
}
const TENSE_LABEL: Record<StyleTense, string> = {
  past: '过去时',
  present: '现在时',
  mixed: '时态混用',
  unknown: '未判定',
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
}

function normalizeRule(text: string): string {
  return text.replace(/\s+/g, '').replace(/[，。；、,.;]/g, '').toLowerCase()
}

/** 数值轴：按维度覆盖后的有效权重做加权平均，返回各轴来源分歧（用于提示）。 */
export function blendAxes(
  sources: BlendSourceInput[],
  recipe: StyleRecipe,
): { axes: StyleAxes; dispersion: Partial<Record<keyof StyleAxes, number>> } {
  const axes = {} as StyleAxes
  const dispersion: Partial<Record<keyof StyleAxes, number>> = {}
  const allKeys = Object.keys(DIMENSION_AXES).flatMap(
    (dim) => DIMENSION_AXES[dim as StyleDimensionKey],
  ) as (keyof StyleAxes)[]
  const uniqueKeys = [...new Set(allKeys)]

  for (const key of uniqueKeys) {
    const dim = AXIS_TO_DIMENSION[key]
    const weighted = sources.map((s) => {
      const override = dim ? recipe.dimensionWeights?.[dim]?.[s.sourceId] : undefined
      const weight = Math.max(0, override ?? itemWeight(recipe, s.sourceId))
      return { value: Number(s.profile.payload?.axes?.[key] ?? 0), weight }
    })
    const total = weighted.reduce((sum, w) => sum + w.weight, 0)
    axes[key] = total ? +(weighted.reduce((sum, w) => sum + w.value * w.weight, 0) / total).toFixed(2) : 0
    if (weighted.length >= 3 && total) {
      const mean = axes[key]
      const variance = weighted.reduce((sum, w) => sum + w.weight * (w.value - mean) ** 2, 0) / total
      const sd = Math.sqrt(variance)
      dispersion[key] = mean ? +(sd / Math.abs(mean)).toFixed(2) : 0
    }
  }
  // chapterAvgLen 用全局权重单独融合
  const totalW = sources.reduce((sum, s) => sum + itemWeight(recipe, s.sourceId), 0)
  axes.chapterAvgLen = totalW
    ? Math.round(sources.reduce((sum, s) => sum + (s.profile.payload?.axes?.chapterAvgLen ?? 0) * itemWeight(recipe, s.sourceId), 0) / totalW)
    : 0

  return { axes, dispersion }
}

function itemWeight(recipe: StyleRecipe, sourceId: string): number {
  return recipe.items.find((i) => i.sourceId === sourceId)?.weight ?? 0
}

/** 分类维度：置信度 × 权重的加权投票；前二差距 <0.2 记冲突。 */
export function voteCategorical(
  sources: BlendSourceInput[],
  recipe: StyleRecipe,
  field: 'pov' | 'tense',
): { value: string; conflict?: StyleConflict } {
  const tally = new Map<string, { score: number; names: string[] }>()
  for (const s of sources) {
    const raw = String((s.profile.payload?.categorical as any)?.[field] ?? 'unknown')
    if (raw === 'unknown') continue
    const score = itemWeight(recipe, s.sourceId) * clamp01(s.profile.payload?.confidence ?? 0)
    const cur = tally.get(raw) ?? { score: 0, names: [] }
    cur.score += score
    cur.names.push(s.name)
    tally.set(raw, cur)
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].score - a[1].score)
  if (!ranked.length) return { value: 'unknown' }
  const [winValue, win] = ranked[0]
  const runner = ranked[1]
  if (runner && win.score > 0 && runner[1].score / win.score > 0.8) {
    return {
      value: winValue,
      conflict: {
        kind: field,
        message:
          field === 'pov'
            ? `来源人称不一致：${ranked.map(([v, t]) => `${POV_LABEL[v as StylePov] ?? v}(${t.names.join('、')})`).join(' / ')}，默认跟随本书`
            : `来源时态不一致：${ranked.map(([v, t]) => `${TENSE_LABEL[v as StyleTense] ?? v}(${t.names.join('、')})`).join(' / ')}，默认跟随本书`,
        values: ranked.map(([v, t]) => ({ sourceId: t.names.join(','), name: t.names.join('、'), value: v })),
      },
    }
  }
  return { value: winValue }
}

export function mergeRules(sources: BlendSourceInput[], recipe: StyleRecipe): { do: StyleRule[]; dont: StyleRule[] } {
  const collect = (kind: 'do' | 'dont') => {
    const map = new Map<string, { text: string; score: number; weight: number; confidence: number }>()
    for (const s of sources) {
      const weight = itemWeight(recipe, s.sourceId)
      for (const rule of s.profile.payload?.rules?.[kind] ?? []) {
        const key = normalizeRule(rule.text)
        if (!key) continue
        const cur = map.get(key) ?? { text: rule.text, score: 0, weight: 0, confidence: 0 }
        cur.score += weight * clamp01(rule.confidence)
        cur.weight += weight
        cur.confidence = Math.max(cur.confidence, clamp01(rule.confidence))
        map.set(key, cur)
      }
    }
    const totalWeight = sources.reduce((sum, s) => sum + itemWeight(recipe, s.sourceId), 0) || 1
    return [...map.values()]
      .map((r) => {
        const support = r.weight / totalWeight
        return {
          text: r.text,
          confidence: +r.confidence.toFixed(2),
          tier: (support >= RULE_TIER_MUST ? 'must' : support >= RULE_TIER_SHOULD ? 'should' : undefined) as StyleRule['tier'],
          support,
        }
      })
      // 低支持规则只在强度较高时保留
      .filter((r) => r.support >= RULE_TIER_SHOULD || recipe.strength >= 70)
      .sort((a, b) => (b.tier === 'must' ? 1 : 0) - (a.tier === 'must' ? 1 : 0) || b.confidence - a.confidence)
      .slice(0, MAX_RULES)
      .map(({ text, confidence, tier }) => ({ text, confidence, tier }))
  }
  return { do: collect('do'), dont: collect('dont') }
}

export function mergeLexicon(sources: BlendSourceInput[]): StyleLexicon {
  const preferred = new Set<string>()
  const avoid = new Set<string>()
  for (const s of sources) {
    for (const w of s.profile.payload?.lexicon?.preferred ?? []) preferred.add(w)
    for (const w of s.profile.payload?.lexicon?.avoid ?? []) avoid.add(w)
  }
  // 同一词既偏好又回避时，回避优先（保守）
  for (const w of avoid) preferred.delete(w)
  return { preferred: [...preferred].slice(0, 20), avoid: [...avoid].slice(0, 20) }
}

/** 锚点：按来源权重分配名额，单条 ≤160 字、总预算 ≤ anchorBudget、最多 4 条。 */
export function selectAnchors(sources: BlendSourceInput[], recipe: StyleRecipe): StyleAnchor[] {
  if (recipe.anchorMode === 'abstract') return []
  const budget = Math.max(0, recipe.anchorBudget || 0)
  if (!budget) return []
  const quotas = new Map<string, number>()
  const totalWeight = sources.reduce((sum, s) => sum + itemWeight(recipe, s.sourceId), 0) || 1
  for (const s of sources) {
    quotas.set(s.sourceId, Math.max(1, Math.round((itemWeight(recipe, s.sourceId) / totalWeight) * MAX_ANCHORS)))
  }
  const picked: { source: BlendSourceInput; anchor: StyleAnchor }[] = []
  const used = new Set<string>()
  const pushFrom = (s: BlendSourceInput, limit: number) => {
    const candidates = [...s.anchors]
      .filter((a) => !used.has(a.id) && a.text.trim() && a.text.length <= ANCHOR_ITEM_MAX)
      .sort((a, b) => b.quality - a.quality)
    let n = 0
    for (const a of candidates) {
      if (n >= limit) break
      picked.push({ source: s, anchor: a })
      used.add(a.id)
      n += 1
    }
  }
  // 每源至少 1 条；名额按权重
  for (const s of sources) pushFrom(s, quotas.get(s.sourceId) ?? 1)
  // 预算内补齐
  for (const s of sources) {
    if (picked.length >= MAX_ANCHORS) break
    pushFrom(s, MAX_ANCHORS)
  }

  const out: StyleAnchor[] = []
  let chars = 0
  for (const { anchor } of picked) {
    if (out.length >= MAX_ANCHORS) break
    if (chars + anchor.charCount > budget) continue
    out.push(anchor)
    chars += anchor.charCount
  }
  return out
}

/** 纯融合：不做 IO，供单测与评估复用。 */
export function blendStyles(recipe: StyleRecipe, sources: BlendSourceInput[]): MergedStyleProfile {
  const active = sources.filter((s) => s.profile?.status === 'ready' || s.profile?.status === 'stale')
  if (!active.length) throw new Error('没有可用的文风画像')
  const { axes, dispersion } = blendAxes(active, recipe)
  const povVote = voteCategorical(active, recipe, 'pov')
  const tenseVote = voteCategorical(active, recipe, 'tense')
  const categories = active.map((s) => s.profile.payload?.categorical).filter(Boolean)
  const tone = topCategory(categories.map((c) => c.tone).filter(Boolean))
  const register = topCategory(categories.map((c) => c.register).filter(Boolean))

  const conflicts: StyleConflict[] = []
  if (povVote.conflict) conflicts.push(povVote.conflict)
  if (tenseVote.conflict) conflicts.push(tenseVote.conflict)
  for (const [axis, value] of Object.entries(dispersion)) {
    if ((value ?? 0) > 0.35) {
      conflicts.push({
        kind: 'categorical',
        message: `来源在「${axis}」上分歧较大（离散度 ${value}），已按权重取中`,
        values: active.map((s) => ({ sourceId: s.sourceId, name: s.name, value: String(s.profile.payload?.axes?.[axis as keyof StyleAxes] ?? '') })),
      })
    }
  }

  const pov = recipe.povPolicy === 'follow_recipe' && recipe.povOverride ? recipe.povOverride : (povVote.value as StylePov)
  const categorical: StyleCategorical = {
    pov,
    tense: tenseVote.value as StyleTense,
    tone,
    register,
  }

  const totalWeight = active.reduce((sum, s) => sum + itemWeight(recipe, s.sourceId), 0) || 1
  const confidence =
    active.reduce((sum, s) => sum + (s.profile.payload?.confidence ?? 0) * itemWeight(recipe, s.sourceId), 0) / totalWeight
  const sourceNames = active.map((s) => s.name)
  const summary = buildMergedSummary(active, sourceNames, categorical, recipe)
  const craft = mergeStyleCraft(
    active.map((s) => ({ craft: s.profile.payload?.craft, weight: itemWeight(recipe, s.sourceId) })),
  )

  return {
    recipeId: recipe.id,
    recipeName: recipe.name,
    strength: recipe.strength,
    anchorMode: recipe.anchorMode,
    sourceNames,
    summary,
    axes,
    categorical,
    dimensions: mergeDimensions(active),
    rules: mergeRules(active, recipe),
    lexicon: mergeLexicon(active),
    sourceEntities: topEntities(active),
    anchors: selectAnchors(active, recipe),
    extraRules: recipe.extraRules ?? [],
    conflicts,
    confidence: +confidence.toFixed(2),
    ...(craft ? { craft } : {}),
    mergedFrom: active.map((s) => ({
      sourceId: s.sourceId,
      name: s.name,
      profileId: s.profile.id,
      weight: itemWeight(recipe, s.sourceId),
      confidence: s.profile.payload?.confidence ?? 0,
    })),
  }
}

function topCategory(values: string[]): string {
  const tally = new Map<string, number>()
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

function mergeDimensions(sources: BlendSourceInput[]): StyleDimension[] {
  const byKey = new Map<StyleDimensionKey, { value: string; confidence: number; evidence: string[]; totalWeight: number; name: string }>()
  for (const s of sources) {
    const weight = Math.max(0.01, s.profile.payload?.confidence ?? 0)
    for (const dim of s.profile.payload?.dimensions ?? []) {
      const cur = byKey.get(dim.key)
      if (!cur) {
        byKey.set(dim.key, {
          value: dim.value,
          confidence: dim.confidence ?? 0,
          evidence: dim.evidence ?? [],
          totalWeight: weight,
          name: s.name,
        })
      } else if ((dim.confidence ?? 0) > cur.confidence) {
        cur.value = dim.value
        cur.confidence = dim.confidence ?? 0
        cur.evidence = dim.evidence ?? []
        cur.totalWeight += weight
        cur.name = s.name
      }
    }
  }
  return [...byKey.entries()].map(([key, d]) => ({
    key,
    value: d.value,
    confidence: +Math.min(1, d.confidence).toFixed(2),
    evidence: d.evidence.slice(0, 2),
    variants: d.name ? [`主结论来自 ${d.name}`] : undefined,
  }))
}

function topEntities(sources: BlendSourceInput[]): string[] {
  const tally = new Map<string, number>()
  for (const s of sources) {
    for (const e of s.profile.payload?.sourceEntities ?? []) tally.set(e, (tally.get(e) ?? 0) + 1)
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e)
    .slice(0, 20)
}

function buildMergedSummary(
  sources: BlendSourceInput[],
  names: string[],
  categorical: StyleCategorical,
  recipe: StyleRecipe,
): string {
  const base = sources
    .slice()
    .sort((a, b) => (b.profile.payload?.confidence ?? 0) - (a.profile.payload?.confidence ?? 0))[0]
    ?.profile.payload?.summary
  const label = names.join(' + ')
  const pov = POV_LABEL[categorical.pov] ?? ''
  const prefix = names.length > 1 ? `${label} 融合风格（${pov}）` : base?.slice(0, 160) || label
  if (names.length === 1) return prefix
  return `${prefix}。${base ? base.slice(0, 100) : ''}`.slice(0, 200)
}

/**
 * 取本书当前生效的融合画像。任何查询/解析失败返回 null（正文照常生成）。
 * 配方引用来源缺失时跳过；没有任何可用画像时回退 null。
 */
export async function loadMergedStyleForNovel(novelId: string): Promise<MergedStyleProfile | null> {
  try {
    const binding = await getStyleBinding(novelId)
    if (!binding || !binding.enabled) return null
    const recipe = await getStyleRecipe(binding.recipeId)
    if (!recipe) return null
    const effectiveStrength =
      binding.strengthOverride != null ? Math.max(0, Math.min(100, binding.strengthOverride)) : recipe.strength
    if (effectiveStrength <= 0) return null
    const effectiveRecipe: StyleRecipe = { ...recipe, strength: effectiveStrength }

    const sources: BlendSourceInput[] = []
    for (const item of effectiveRecipe.items) {
      const profile = await getStyleProfile(item.profileId)
      if (!profile || (profile.status !== 'ready' && profile.status !== 'stale')) continue
      const source = await getStyleSource(profile.sourceId)
      const anchors = await listStyleAnchors(profile.id)
      sources.push({
        sourceId: profile.sourceId,
        name: source?.name ?? profile.sourceId,
        profile,
        anchors,
      })
    }
    if (!sources.length) return null
    return blendStyles(effectiveRecipe, sources)
  } catch (e) {
    console.warn('[style] load merged profile failed:', e)
    return null
  }
}

export const STYLE_ANCHOR_KIND_LABEL: Record<StyleAnchorKind, string> = {
  dialogue: '对话',
  action: '动作',
  description: '描写',
  interior: '内心',
  transition: '转场',
  chapter_end: '章末',
  other: '其他',
}
