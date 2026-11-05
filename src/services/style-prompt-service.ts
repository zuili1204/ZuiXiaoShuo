// P2 文风提示词渲染：把 MergedStyleProfile 压成注入 system prompt 的文本。
// 预算默认 1,200 字并按强度缩放；裁剪顺序：摘要 > must 规则 > 数值目标 > avoid 规则 > 锚点。
import type { MergedStyleProfile, StyleCraftData, StyleRule } from '@shared/style-types'
import { STYLE_FUNCTION_POSITION_LABEL } from '@shared/style-types'

export interface StylePrompt {
  text: string
  meta: {
    recipeId: string
    recipeName: string
    strength: number
    sourceNames: string[]
  }
}

const POV_LABEL: Record<string, string> = {
  first: '第一人称',
  third_limited: '第三人称限知',
  third_omniscient: '第三人称全知',
  mixed: '人称混用（按本书章节习惯）',
  unknown: '',
}
const TENSE_LABEL: Record<string, string> = {
  past: '过去时',
  present: '现在时',
  mixed: '时态混用',
  unknown: '',
}

function tierOf(strength: number): { rules: number; anchors: number; numeric: boolean; strong: boolean } {
  if (strength <= 0) return { rules: 0, anchors: 0, numeric: false, strong: false }
  if (strength <= 30) return { rules: 4, anchors: 0, numeric: false, strong: false }
  if (strength <= 60) return { rules: 8, anchors: 1, numeric: false, strong: false }
  if (strength <= 80) return { rules: 10, anchors: 3, numeric: true, strong: false }
  return { rules: 14, anchors: 4, numeric: true, strong: true }
}

/** 预算按强度缩放；强度 0 不注入。 */
export function stylePromptBudget(strength: number): number {
  return Math.round(500 + Math.max(0, Math.min(100, strength)) * 7)
}

function pickRules(rules: StyleRule[], limit: number): StyleRule[] {
  return [...rules]
    .sort((a, b) => {
      const tier = (r: StyleRule) => (r.tier === 'must' ? 0 : r.tier === 'should' ? 1 : 2)
      return tier(a) - tier(b) || b.confidence - a.confidence
    })
    .slice(0, limit)
}

function numericTargets(m: MergedStyleProfile): string {
  const a = m.axes
  const parts: string[] = []
  if (a.sentenceAvgLen) parts.push(`句均长约 ${Math.round(a.sentenceAvgLen)} 字`)
  if (a.shortSentencePct) parts.push(`10 字内短句约 ${Math.round(a.shortSentencePct)}%`)
  if (a.longSentencePct) parts.push(`60 字以上长句不超过 ${Math.max(1, Math.round(a.longSentencePct))}%`)
  if (a.dialoguePct) parts.push(`对话占正文约 ${Math.round(a.dialoguePct)}%`)
  if (a.dialogueAvgLen) parts.push(`单句对话平均 ${Math.round(a.dialogueAvgLen)} 字`)
  if (a.simileStrictPer1k) parts.push(`严格比喻密度约 ${a.simileStrictPer1k}/千字`)
  if (a.interiorityPct) parts.push(`心理描写句约占 ${Math.round(a.interiorityPct)}%`)
  if (a.hookEndingPct) parts.push(`章末留下钩子的比例约 ${Math.round(a.hookEndingPct)}%`)
  if (a.colloquialPct) parts.push(`口语化句子约 ${Math.round(a.colloquialPct)}%`)
  return parts.join('；')
}

/**
 * 叙事工程层：只注入可迁移的结构（功能位/开篇/章末/关系与情节引擎/禁忌/角色声音），
 * 严禁把人名、地名、专有设定带进新书。
 */
export function renderCraftBlock(craft?: StyleCraftData): string {
  if (!craft) return ''
  const lines: string[] = []
  const positions = craft.functionPositions.filter((f) => f.transferable).slice(0, 2)
  if (positions.length) {
    lines.push(
      `功能位：${positions
        .map((f) => `${STYLE_FUNCTION_POSITION_LABEL[f.key]}（${f.description.slice(0, 36)}）`)
        .join('；')}`,
    )
  }
  const voices = craft.voices
    .filter((v) => v.verbalTics.length || v.sentenceAvgLen)
    .slice(0, 2)
  if (voices.length) {
    lines.push(
      `角色声音：${voices
        .map((v) => {
          const tic = v.verbalTics.length ? `常说「${v.verbalTics.slice(0, 2).join('、')}」` : ''
          const len = v.sentenceAvgLen ? `句均约 ${Math.round(v.sentenceAvgLen)} 字` : ''
          return `${v.characterRole}${[tic, len].filter(Boolean).join('，')}`
        })
        .join('；')}`,
    )
  }
  if (craft.chapterEngineering.openingPatterns.length) {
    lines.push(`开篇：${craft.chapterEngineering.openingPatterns.slice(0, 1).join('；')}`)
  }
  if (craft.chapterEngineering.endingPatterns.length) {
    lines.push(`章末停在：${craft.chapterEngineering.endingPatterns.slice(0, 2).join('；')}`)
  }
  if (craft.relationshipEngine.length) lines.push(`关系推进：${craft.relationshipEngine.slice(0, 1).join('；')}`)
  if (craft.plotEngine.length) lines.push(`情节引擎：${craft.plotEngine.slice(0, 1).join('；')}`)
  if (craft.taboos.length) lines.push(`不写：${craft.taboos.slice(0, 2).join('；')}`)
  if (!lines.length) return ''
  return `【叙事工程（只学结构，禁止复用原书人名/地名/设定与情节）】\n${lines.map((l) => `- ${l}`).join('\n')}`
}

export function renderStylePrompt(merged: MergedStyleProfile | null): StylePrompt | null {
  if (!merged || merged.strength <= 0) return null
  const tier = tierOf(merged.strength)
  const budget = stylePromptBudget(merged.strength)
  const meta = {
    recipeId: merged.recipeId,
    recipeName: merged.recipeName,
    strength: merged.strength,
    sourceNames: merged.sourceNames,
  }

  // 1) 先按优先级挑选可用片段
  const doRules = pickRules(merged.rules.do, tier.rules)
  const dontRules = pickRules(merged.rules.dont, Math.max(3, Math.ceil(tier.rules / 2)))
  const numeric = tier.numeric ? numericTargets(merged) : ''
  // 强度 >30 才注入叙事工程层：低强度按设计只给表达规则
  const craft = merged.strength > 30 ? renderCraftBlock(merged.craft) : ''
  const anchors = merged.anchors.slice(0, tier.anchors)
  const summary = merged.summary.slice(0, 200)
  const pov = POV_LABEL[merged.categorical.pov] ?? ''
  const tense = TENSE_LABEL[merged.categorical.tense] ?? ''
  const tone = merged.categorical.tone ? `基调偏「${merged.categorical.tone}」` : ''
  const avoid = merged.lexicon.avoid.slice(0, 10)

  // 2) 按优先级组装（摘要 > 手写规则 > must > 数值 > avoid > 锚点），超预算时跳过低优先级
  const blocks: { key: string; text: string; priority: number }[] = []
  if (summary) blocks.push({ key: 'summary', text: `【总体语感】${summary}`, priority: 1 })
  if (merged.extraRules.length) {
    blocks.push({
      key: 'extra',
      text: `【作者指定】\n${merged.extraRules.map((t) => `- ${t}`).join('\n')}`,
      priority: 1,
    })
  }
  const doText = doRules.map((r) => r.text).filter(Boolean)
  if (doText.length) blocks.push({ key: 'do', text: `【句法与表达】\n${doText.map((t) => `- ${t}`).join('\n')}`, priority: 2 })
  const styleLine = [pov, tense, tone].filter(Boolean).join('，')
  if (styleLine) blocks.push({ key: 'voice', text: `【叙述口吻】${styleLine}`, priority: 2 })
  if (craft) blocks.push({ key: 'craft', text: craft, priority: 3 })
  if (numeric) blocks.push({ key: 'numeric', text: `【量化目标】${numeric}`, priority: 3 })
  const dontText = dontRules.map((r) => r.text).filter(Boolean)
  if (dontText.length) blocks.push({ key: 'dont', text: `【必须避免】\n${dontText.map((t) => `- ${t}`).join('\n')}`, priority: 4 })
  if (avoid.length) blocks.push({ key: 'lexicon', text: `【少用词汇】${avoid.join('、')}`, priority: 4 })
  if (anchors.length) {
    const anchorText = anchors
      .map((a) => `-（${a.kind}）${a.text}`)
      .join('\n')
    blocks.push({
      key: 'anchors',
      text: `【风格锚点（只学语感，禁止复用其中的人名/地名/专有名词与情节）】\n${anchorText}`,
      priority: 5,
    })
  }

  const header =
    '## 文风目标（只影响表达方式）\n\n' +
    '> 本区块只约束“怎么写”，不改变“写什么”。若与人物设定、世界观、时间线、本章 hooks、用户指令冲突，一律以后者为准。'
  const strong = tier.strong
    ? '\n> 强度较高：优先模仿上述语感与节奏，但仍以故事事实和用户指令为准。'
    : ''

  const chosen = new Set<string>()
  let used = (header + strong).length
  for (const block of [...blocks].sort((a, b) => a.priority - b.priority)) {
    const cost = block.text.length + 2
    if (used + cost > budget && block.priority > 1) continue
    chosen.add(block.key)
    used += cost
  }
  const order = ['summary', 'extra', 'voice', 'do', 'craft', 'numeric', 'dont', 'lexicon', 'anchors']
  const ordered = order
    .map((key) => blocks.find((b) => b.key === key))
    .filter((b): b is { key: string; text: string; priority: number } => !!b && chosen.has(b.key))
    .map((b) => b.text)

  const full = [header + strong, ...ordered].join('\n\n')
  const cap = Math.max(budget, header.length + strong.length)
  let text = full
  if (full.length > cap) {
    // 在块边界截断，避免把某条规则从中间切断
    const cut = full.lastIndexOf('\n\n', cap)
    text = cut > header.length + strong.length ? full.slice(0, cut) : full.slice(0, cap)
  }
  return { text, meta }
}
