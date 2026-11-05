// 规划阶段的“叙事工程卡”：只注入结构、节奏、章末类型与作者锚点，
// 不注入完整文风提示词，避免规划结论被句子层面的风格污染。
import type { MergedStyleProfile, StyleAnchor, StyleDimensionKey } from '@shared/style-types'
import { STYLE_FUNCTION_POSITION_LABEL } from '@shared/style-types'
import type { PlanStage } from './planning-skill-service'
import { loadMergedStyleForNovel } from './style-blend-service'

export interface PlanningStyleContext {
  sourceNames: string[]
  strength: number
  craftCard: string
  anchors: string[]
}

const CRAFT_DIMENSIONS: { key: StyleDimensionKey; label: string }[] = [
  { key: 'chapter_engineering', label: '章节工程' },
  { key: 'hook_design', label: '钩子设计' },
  { key: 'relationship_engine', label: '关系引擎' },
  { key: 'setting_function', label: '设定功能' },
  { key: 'concreteness', label: '具体度' },
  { key: 'character_voice', label: '角色声音' },
  { key: 'meta_humor', label: '元叙事与幽默' },
  { key: 'taboo_boundary', label: '禁忌边界' },
  { key: 'pacing_hooks', label: '节奏与钩子' },
  { key: 'characterization', label: '角色塑造' },
  { key: 'dialogue', label: '对话' },
  { key: 'humor_tone', label: '幽默与语气' },
  { key: 'description', label: '描写' },
  { key: 'interiority', label: '内心' },
]

const ANCHOR_ORDER: StyleAnchor['kind'][] = ['chapter_end', 'dialogue', 'action', 'description', 'interior', 'transition', 'other']

/** 不同规划阶段需要的锚点类型不同：A1/A3 看章末与动作，A4 看台词与内心，A2/A6 少量即可 */
const STAGE_ANCHOR_KINDS: Partial<Record<PlanStage, StyleAnchor['kind'][]>> = {
  seed: ['chapter_end', 'dialogue', 'action'],
  'seed-assist': ['chapter_end', 'dialogue', 'action'],
  master: ['chapter_end', 'transition'],
  'volume-chapters': ['chapter_end', 'action', 'dialogue', 'description'],
  'chapter-detail': ['dialogue', 'action', 'description', 'interior'],
  review: ['chapter_end', 'dialogue'],
  calibrate: ['chapter_end', 'action'],
}

const STAGE_ANCHOR_LIMIT: Partial<Record<PlanStage, number>> = {
  seed: 3,
  'seed-assist': 3,
  master: 2,
  'volume-chapters': 4,
  'chapter-detail': 4,
  review: 2,
  calibrate: 2,
}

/** 没有绑定文风库时也会注入的“现代连载语法”，替代模型训练语料的均值先验。 */
export const MODERN_SERIAL_BASELINE =
  '当下连载口味（默认，除非作者方向另行要求）：\n' +
  '- 先设计“能反复发生的单元”：固定地点、固定仪式、固定几个人，每周都能再来一次。\n' +
  '- 关系写成状态机：当前标签 → 升级条件 → 退化条件；不要只写“他们关系很好”。\n' +
  '- 每章至少发生一项：公共事件、关系标签变化、信息揭示、可复用名场面。\n' +
  '- 章末停在画面/动作/台词/信息/未完成动作/误会之一；禁止总结、升华、点题。\n' +
  '- 设定优先回答“能制造什么名场面、怎么让两个人靠近”，而不是“如何惩罚主角”。\n' +
  '- 代价是可选风味：可以轻、可以可控、可以只服务喜剧节奏；不要默认“越用越惨/不可逆/宿命”。\n' +
  '- 五个功能位至少覆盖 3 个：可见进度条 / 可重复仪式 / 合法亲密借口 / 公开关系地图 / 元叙事安全阀。\n' +
  '- 宁要一个具体场面，不要三句抽象形容。'

function oneLine(text: string, max = 120): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function axisLine(merged: MergedStyleProfile): string {
  const a = merged.axes
  const parts: string[] = []
  if (a.chapterAvgLen) parts.push(`单章约 ${Math.round(a.chapterAvgLen)} 字`)
  if (a.sentenceAvgLen) parts.push(`句均 ${Math.round(a.sentenceAvgLen)} 字`)
  if (a.dialoguePct) parts.push(`对话约 ${Math.round(a.dialoguePct)}%`)
  if (a.openingInMediaResPct) parts.push(`开篇直接进场景约 ${Math.round(a.openingInMediaResPct)}%`)
  if (a.endingMedianLen) parts.push(`章末中位 ${Math.round(a.endingMedianLen)} 字`)
  if (a.hookEndingPct) parts.push(`章末留钩约 ${Math.round(a.hookEndingPct)}%`)
  if (a.titleNamePct) parts.push(`标题含角色名约 ${Math.round(a.titleNamePct)}%`)
  if (a.concreteObjectPer1k) parts.push(`具体物件 ${a.concreteObjectPer1k}/千字`)
  if (a.explanationPer1k) parts.push(`解释句 ${a.explanationPer1k}/千字`)
  if (a.publicEventPerChapter) parts.push(`公共事件 ${a.publicEventPerChapter}/章`)
  if (a.tabooRatio) parts.push(`触碰禁忌的章节约 ${Math.round(a.tabooRatio * 100)}%`)
  if (a.shortReplyPct) parts.push(`短回复约 ${Math.round(a.shortReplyPct)}%`)
  return parts.join('；')
}

function craftSections(merged: MergedStyleProfile): string[] {
  const craft = merged.craft
  if (!craft) return []
  const lines: string[] = []

  const positions = craft.functionPositions.filter((p) => p.transferable).slice(0, 3)
  if (positions.length) {
    lines.push('【功能位（只学干活方式，不搬设定）】')
    for (const p of positions) {
      lines.push(`- ${STYLE_FUNCTION_POSITION_LABEL[p.key]}：${oneLine(p.description, 70)}`)
    }
  }

  const scenes = craft.sceneBank.filter((s) => s.transferable).slice(0, 4)
  if (scenes.length) {
    lines.push('【可重复场景】')
    for (const s of scenes) {
      lines.push(`- ${oneLine(s.scene, 40)}${s.function ? `（${oneLine(s.function, 24)}）` : ''}`)
    }
  }

  const voices = craft.voices.slice(0, 3)
  if (voices.length) {
    lines.push('【角色声音（按功能位，不是原书真名）】')
    for (const v of voices) {
      const bits = [
        v.verbalTics.length ? `口头禅「${v.verbalTics.slice(0, 2).join('、')}」` : '',
        v.sentenceAvgLen ? `句均 ${Math.round(v.sentenceAvgLen)} 字` : '',
        v.tabooPhrases.length ? `不说「${v.tabooPhrases.slice(0, 1).join('')}」` : '',
      ].filter(Boolean)
      if (bits.length) lines.push(`- ${v.characterRole}：${bits.join('，')}`)
    }
  }

  const eng = craft.chapterEngineering
  if (eng.openingPatterns.length || eng.endingPatterns.length || eng.titlePatterns.length) {
    lines.push('【章节工程】')
    if (eng.openingPatterns.length) {
      lines.push(`- 开篇：${eng.openingPatterns.slice(0, 2).map((p) => oneLine(p, 50)).join('；')}`)
    }
    if (eng.endingPatterns.length) {
      lines.push(`- 章末：${eng.endingPatterns.slice(0, 2).map((p) => oneLine(p, 50)).join('；')}`)
    }
    if (eng.titlePatterns.length) {
      lines.push(`- 标题：${oneLine(eng.titlePatterns[0], 60)}`)
    }
  }

  if (craft.relationshipEngine.length) {
    lines.push('【关系引擎】', ...craft.relationshipEngine.slice(0, 2).map((r) => `- ${oneLine(r, 70)}`))
  }
  if (craft.plotEngine.length) {
    lines.push('【情节引擎】', ...craft.plotEngine.slice(0, 2).map((r) => `- ${oneLine(r, 70)}`))
  }
  if (craft.taboos.length) {
    lines.push(`【禁忌】${craft.taboos.slice(0, 3).map((t) => oneLine(t, 40)).join('；')}`)
  }
  return lines
}

function pickAnchors(
  merged: MergedStyleProfile,
  limit = 4,
  order: StyleAnchor['kind'][] = ANCHOR_ORDER,
): string[] {
  const picked: StyleAnchor[] = []
  for (const kind of order) {
    if (picked.length >= limit) break
    const hit = merged.anchors.find((a) => a.kind === kind && a.text.trim())
    if (hit) picked.push(hit)
  }
  for (const anchor of merged.anchors) {
    if (picked.length >= limit) break
    if (!picked.includes(anchor)) picked.push(anchor)
  }
  return picked.map((a) => `［${a.kind}］${oneLine(a.text)}`)
}

/** 把融合画像压成规划可用的叙事工程卡；纯函数，便于单测。 */
export function renderCraftCard(merged: MergedStyleProfile): string {
  const lines: string[] = []
  const dims = CRAFT_DIMENSIONS.map(({ key, label }) => {
    const dim = merged.dimensions.find((d) => d.key === key && d.value?.trim())
    if (!dim) return ''
    return `- ${label}：${oneLine(dim.value, 90)}`
  }).filter(Boolean)
  if (dims.length) lines.push('【叙事工程】', ...dims.slice(0, merged.craft ? 3 : 4))

  const structure = craftSections(merged)
  if (structure.length) lines.push(...structure)

  const axes = axisLine(merged)
  if (axes) lines.push(`【节奏指纹】${axes}`)

  const doRules = merged.rules.do
    .slice()
    .sort((a, b) => (a.tier === 'must' ? -1 : 0) - (b.tier === 'must' ? -1 : 0) || b.confidence - a.confidence)
    .slice(0, 3)
    .map((r) => oneLine(r.text, 80))
  if (doRules.length) lines.push('【优先这样做】', ...doRules.map((r) => `- ${r}`))

  const dontRules = merged.rules.dont.slice(0, 2).map((r) => oneLine(r.text, 80))
  if (dontRules.length) lines.push('【避免】', ...dontRules.map((r) => `- ${r}`))

  if (merged.sourceNames.length) {
    lines.push(`【参照来源】${merged.sourceNames.join(' + ')}（只学结构，不搬人名、地名与情节）`)
  }
  return lines.join('\n')
}

/** 作者锚点：给规划提供 few-shot，不参与最终正文生成。 */
export function renderAuthorAnchors(
  merged: MergedStyleProfile,
  limit = 4,
  kinds?: StyleAnchor['kind'][],
): string[] {
  return pickAnchors(merged, limit, kinds ?? ANCHOR_ORDER)
}

export async function loadPlanningStyleContext(novelId: string): Promise<PlanningStyleContext | null> {
  try {
    const merged = await loadMergedStyleForNovel(novelId)
    if (!merged) return null
    return {
      sourceNames: merged.sourceNames,
      strength: merged.strength,
      craftCard: renderCraftCard(merged),
      anchors: renderAuthorAnchors(merged),
    }
  } catch (e) {
    console.warn('[planning-style] load failed:', e)
    return null
  }
}

function stageAnchors(anchors: string[], stage?: PlanStage): string[] {
  if (!stage) return anchors.slice(0, 4)
  const kinds = STAGE_ANCHOR_KINDS[stage]
  const limit = STAGE_ANCHOR_LIMIT[stage] ?? 2
  if (!kinds) return anchors.slice(0, limit)
  const filtered = anchors.filter((a) => kinds.some((kind) => a.startsWith(`［${kind}］`)))
  return (filtered.length ? filtered : anchors).slice(0, limit)
}

/** 规划 prompt 片段：基线始终有，作者锚点有则追加；锚点类型随阶段变化。 */
export function planningCraftSection(ctx?: PlanningStyleContext | null, stage?: PlanStage): string {
  const blocks = [MODERN_SERIAL_BASELINE]
  if (ctx?.craftCard.trim()) {
    blocks.push(`作者作品的叙事指纹（只学结构与节奏，禁止复用其中的人名/地名/专有名词与情节）：\n${ctx.craftCard}`)
  }
  const anchors = ctx?.anchors.length ? stageAnchors(ctx.anchors, stage) : []
  if (anchors.length) {
    blocks.push(
      `作者原作的场面锚点（只学“怎么落一个画面”，禁止复用其中的人名/地名/专有名词与情节）：\n${anchors
        .map((a) => `- ${a}`)
        .join('\n')}`,
    )
  }
  return blocks.join('\n\n')
}
