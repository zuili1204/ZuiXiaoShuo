// 叙事工程层（Craft Layer）的规范化与合并：
// 只保留“怎么设计”的结构信息，丢弃原书人名/地名/专有名词；纯函数，便于单测。
import type {
  StyleCraftComparison,
  StyleCraftData,
  StyleFunctionPosition,
  StyleFunctionPositionKey,
  StyleSceneBankItem,
  StyleVoiceProfile,
} from './style-types'
import { STYLE_FUNCTION_POSITION_KEYS } from './style-types'

const MAX_SCENES = 24
const MAX_VOICES = 8
const MAX_TABOOS = 12
const MAX_ENGINE = 8
const MAX_PATTERNS = 6
const MAX_COMPARISONS = 8

function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function textArray(raw: unknown, maxItem: number, maxCount: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const value = text(item, maxItem)
    if (value && !out.includes(value)) out.push(value)
    if (out.length >= maxCount) break
  }
  return out
}

function num(raw: unknown, max: number, fallback = 0): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return +Math.max(0, Math.min(max, n)).toFixed(1)
}

function bool(raw: unknown, fallback = true): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

function isFunctionPositionKey(raw: unknown): raw is StyleFunctionPositionKey {
  return typeof raw === 'string' && (STYLE_FUNCTION_POSITION_KEYS as readonly string[]).includes(raw)
}

function rewriteStrings(value: unknown, rewrite: (s: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value)
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, rewrite))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = rewriteStrings(item, rewrite)
    return out
  }
  return value
}

/**
 * 模型偶尔会把原书人名写进 evidence，落库前按已知实体统一替换为甲乙丙……
 * 只做兜底，不替代提示词里的“真名替换为甲/乙”要求。
 */
export function redactCraftNames(
  craft: StyleCraftData | null | undefined,
  entityNames: string[],
): StyleCraftData | undefined {
  if (!craft) return undefined
  const names = [...new Set(entityNames.map((name) => name.trim()).filter((name) => name.length >= 2))]
  if (!names.length) return craft
  const aliases = '甲乙丙丁戊己庚辛壬癸'
  const aliasOf = new Map(names.map((name, i) => [name, aliases[i] ?? '某角色']))
  // 长名优先替换，避免“小满公主”先被“小满”截断
  const ordered = [...names].sort((a, b) => b.length - a.length)
  const rewrite = (value: string): string => {
    let out = value
    for (const name of ordered) out = out.split(name).join(aliasOf.get(name) as string)
    return out
  }
  return rewriteStrings(craft, rewrite) as StyleCraftData
}

export function normalizeFunctionPositions(raw: unknown): StyleFunctionPosition[] {
  if (!Array.isArray(raw)) return []
  const out: StyleFunctionPosition[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (!isFunctionPositionKey(o.key)) continue
    if (seen.has(o.key)) continue
    const description = text(o.description, 120)
    if (!description) continue
    seen.add(o.key)
    out.push({
      key: o.key,
      description,
      evidence: textArray(o.evidence, 60, 3),
      transferable: bool(o.transferable, true),
      settingDependency:
        o.settingDependency === 'low' || o.settingDependency === 'high'
          ? o.settingDependency
          : 'medium',
    })
  }
  return out
}

export function normalizeSceneBank(raw: unknown): StyleSceneBankItem[] {
  if (!Array.isArray(raw)) return []
  const out: StyleSceneBankItem[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const scene = text(o.scene, 40)
    if (!scene || seen.has(scene)) continue
    seen.add(scene)
    out.push({
      scene,
      function: text(o.function, 40),
      frequency: Math.max(0, Math.round(num(o.frequency, 10000))),
      transferable: bool(o.transferable, true),
    })
    if (out.length >= MAX_SCENES) break
  }
  return out
}

export function normalizeVoices(raw: unknown): StyleVoiceProfile[] {
  if (!Array.isArray(raw)) return []
  const out: StyleVoiceProfile[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const role = text(o.characterRole, 24)
    if (!role || seen.has(role)) continue
    seen.add(role)
    out.push({
      characterRole: role,
      sentenceAvgLen: num(o.sentenceAvgLen, 500),
      ellipsisPerChapter: num(o.ellipsisPerChapter, 500),
      questionPerChapter: num(o.questionPerChapter, 500),
      exclaimPerChapter: num(o.exclaimPerChapter, 500),
      verbalTics: textArray(o.verbalTics, 30, 6),
      tabooPhrases: textArray(o.tabooPhrases, 40, 6),
      evidence: textArray(o.evidence, 60, 2),
    })
    if (out.length >= MAX_VOICES) break
  }
  return out
}

function normalizeComparison(raw: unknown): StyleCraftComparison[] {
  if (!Array.isArray(raw)) return []
  const out: StyleCraftComparison[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const dimension = text(o.dimension, 30)
    const author = text(o.author, 100)
    if (!dimension || !author || seen.has(dimension)) continue
    seen.add(dimension)
    out.push({
      dimension,
      author,
      aiDefault: text(o.aiDefault, 100),
      rule: text(o.rule, 100),
    })
    if (out.length >= MAX_COMPARISONS) break
  }
  return out
}

/** 把模型返回的任意 craft 对象收紧成可存储结构；完全没有有效内容时返回 null。 */
export function normalizeStyleCraft(raw: unknown): StyleCraftData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const eng = o.chapterEngineering && typeof o.chapterEngineering === 'object'
    ? (o.chapterEngineering as Record<string, unknown>)
    : {}
  const craft: StyleCraftData = {
    functionPositions: normalizeFunctionPositions(o.functionPositions),
    sceneBank: normalizeSceneBank(o.sceneBank),
    voices: normalizeVoices(o.voices),
    taboos: textArray(o.taboos, 60, MAX_TABOOS),
    chapterEngineering: {
      openingPatterns: textArray(eng.openingPatterns, 80, MAX_PATTERNS),
      endingPatterns: textArray(eng.endingPatterns, 80, MAX_PATTERNS),
      titlePatterns: textArray(eng.titlePatterns, 80, MAX_PATTERNS),
    },
    relationshipEngine: textArray(o.relationshipEngine, 100, MAX_ENGINE),
    plotEngine: textArray(o.plotEngine, 100, MAX_ENGINE),
    comparison: normalizeComparison(o.comparison),
  }
  const hasContent =
    craft.functionPositions.length > 0 ||
    craft.sceneBank.length > 0 ||
    craft.voices.length > 0 ||
    craft.taboos.length > 0 ||
    craft.chapterEngineering.openingPatterns.length > 0 ||
    craft.chapterEngineering.endingPatterns.length > 0 ||
    craft.chapterEngineering.titlePatterns.length > 0 ||
    craft.relationshipEngine.length > 0 ||
    craft.plotEngine.length > 0 ||
    craft.comparison.length > 0
  return hasContent ? craft : null
}

/** 角色声音离散度：句均长的变异系数；<2 个声音或均值为 0 时返回 0。 */
export function voiceDispersion(voices: StyleVoiceProfile[]): number {
  const lens = voices.map((v) => v.sentenceAvgLen).filter((n) => n > 0)
  if (lens.length < 2) return 0
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  if (!mean) return 0
  const variance = lens.reduce((s, n) => s + (n - mean) ** 2, 0) / lens.length
  return +(Math.sqrt(variance) / mean).toFixed(2)
}

function dedupePush(target: string[], values: string[], key: (v: string) => string): void {
  for (const value of values) {
    const k = key(value)
    if (!k) continue
    if (target.some((t) => key(t) === k)) continue
    target.push(value)
  }
}

const norm = (s: string) => s.replace(/[\s，。；、,.;:：]/g, '').toLowerCase()

/** 多章/多书合并：按权重排序后取主描述，证据与列表做去重并集。 */
export function mergeStyleCraft(
  entries: { craft?: StyleCraftData | null; weight?: number }[],
): StyleCraftData | undefined {
  const active = entries
    .filter((e): e is { craft: StyleCraftData; weight?: number } => !!e.craft)
    .map((e) => ({ craft: e.craft, weight: Math.max(0.01, e.weight ?? 1) }))
    .sort((a, b) => b.weight - a.weight)
  if (!active.length) return undefined

  const fpMap = new Map<StyleFunctionPositionKey, StyleFunctionPosition>()
  const sceneMap = new Map<string, StyleSceneBankItem>()
  const voiceMap = new Map<string, { voice: StyleVoiceProfile; weight: number; count: number }>()
  const taboos: string[] = []
  const openings: string[] = []
  const endings: string[] = []
  const titles: string[] = []
  const relationship: string[] = []
  const plot: string[] = []
  const comparison: StyleCraftComparison[] = []

  for (const { craft, weight } of active) {
    for (const fp of craft.functionPositions) {
      const prev = fpMap.get(fp.key)
      if (!prev) {
        fpMap.set(fp.key, { ...fp, evidence: [...fp.evidence] })
      } else {
        dedupePush(prev.evidence, fp.evidence, norm)
        prev.transferable = prev.transferable && fp.transferable
        if (fp.settingDependency === 'high' || prev.settingDependency === 'high') prev.settingDependency = 'high'
        else if (fp.settingDependency === 'medium' || prev.settingDependency === 'medium') prev.settingDependency = 'medium'
      }
    }
    for (const scene of craft.sceneBank) {
      const key = norm(scene.scene)
      const prev = sceneMap.get(key)
      if (!prev) sceneMap.set(key, { ...scene })
      else {
        prev.frequency += scene.frequency
        prev.transferable = prev.transferable && scene.transferable
        if (!prev.function) prev.function = scene.function
      }
    }
    for (const voice of craft.voices) {
      const key = norm(voice.characterRole)
      const prev = voiceMap.get(key)
      if (!prev) {
        voiceMap.set(key, { voice: { ...voice }, weight, count: 1 })
      } else {
        const total = prev.weight + weight
        const mix = (a: number, b: number) => +((a * prev.weight + b * weight) / total).toFixed(1)
        prev.voice = {
          ...prev.voice,
          sentenceAvgLen: mix(prev.voice.sentenceAvgLen, voice.sentenceAvgLen),
          ellipsisPerChapter: mix(prev.voice.ellipsisPerChapter, voice.ellipsisPerChapter),
          questionPerChapter: mix(prev.voice.questionPerChapter, voice.questionPerChapter),
          exclaimPerChapter: mix(prev.voice.exclaimPerChapter, voice.exclaimPerChapter),
          verbalTics: [...new Set([...prev.voice.verbalTics, ...voice.verbalTics])].slice(0, 6),
          tabooPhrases: [...new Set([...prev.voice.tabooPhrases, ...voice.tabooPhrases])].slice(0, 6),
          evidence: [...new Set([...prev.voice.evidence, ...voice.evidence])].slice(0, 2),
        }
        prev.weight = total
        prev.count += 1
      }
    }
    dedupePush(taboos, craft.taboos, norm)
    dedupePush(openings, craft.chapterEngineering.openingPatterns, norm)
    dedupePush(endings, craft.chapterEngineering.endingPatterns, norm)
    dedupePush(titles, craft.chapterEngineering.titlePatterns, norm)
    dedupePush(relationship, craft.relationshipEngine, norm)
    dedupePush(plot, craft.plotEngine, norm)
    for (const item of craft.comparison) {
      if (!comparison.some((c) => norm(c.dimension) === norm(item.dimension))) comparison.push({ ...item })
    }
  }

  const merged: StyleCraftData = {
    functionPositions: STYLE_FUNCTION_POSITION_KEYS.map((key) => fpMap.get(key)).filter(
      (fp): fp is StyleFunctionPosition => !!fp,
    ),
    sceneBank: [...sceneMap.values()].sort((a, b) => b.frequency - a.frequency).slice(0, MAX_SCENES),
    voices: [...voiceMap.values()].map((v) => v.voice).slice(0, MAX_VOICES),
    taboos: taboos.slice(0, MAX_TABOOS),
    chapterEngineering: {
      openingPatterns: openings.slice(0, MAX_PATTERNS),
      endingPatterns: endings.slice(0, MAX_PATTERNS),
      titlePatterns: titles.slice(0, MAX_PATTERNS),
    },
    relationshipEngine: relationship.slice(0, MAX_ENGINE),
    plotEngine: plot.slice(0, MAX_ENGINE),
    comparison: comparison.slice(0, MAX_COMPARISONS),
  }
  const hasContent =
    merged.functionPositions.length > 0 ||
    merged.sceneBank.length > 0 ||
    merged.voices.length > 0 ||
    merged.taboos.length > 0 ||
    merged.chapterEngineering.openingPatterns.length > 0 ||
    merged.relationshipEngine.length > 0 ||
    merged.plotEngine.length > 0
  return hasContent ? merged : undefined
}
