// 规划层批评器：确定性检测“过时模板”与“不可写建议”，并给出可比较的分数。
// 设计原则：LLM 只负责想，验收由本地规则负责；同一输入必须得到同一分数。
import type {
  PlanCritiqueMetrics,
  PlanCritiqueResult,
  PlanEvalSummary,
  SeedAssistField,
  SeedFindingSeverity,
  SeedSuggestion,
  SeedSuggestionFinding,
  SeedSuggestionScore,
} from '@shared/types'

export const FUNCTION_POSITIONS = [
  '可见进度条',
  '可重复仪式',
  '合法亲密借口',
  '公开关系地图',
  '元叙事安全阀',
] as const

interface ClichéRule {
  code: string
  label: string
  pattern: RegExp
  severity: SeedFindingSeverity
  /** 不传表示所有字段生效 */
  fields?: SeedAssistField[]
}

const NARRATIVE_FIELDS: SeedAssistField[] = [
  'premise',
  'coreConflict',
  'protagonist',
  'characters',
  'worldview',
  'power',
  'sellingPoints',
  'tone',
]

/**
 * 这些不是“禁用词”，而是“默认语法”的指纹：
 * 命中后不一定错，但会显著降低新鲜度；blocking 会触发一次自动重写。
 */
const CLICHE_RULES: ClichéRule[] = [
  {
    code: 'cost-template',
    label: '代价模板',
    pattern: /(代价(是|为|就)|付出[^，。；]{0,10}代价|必须[^，。；]{0,12}代价)/,
    severity: 'blocking',
    fields: ['premise', 'coreConflict', 'power', 'worldview', 'sellingPoints'],
  },
  {
    code: 'fate-words',
    label: '宿命/救赎大词',
    pattern: /(宿命|命中注定|命运的齿轮|救赎|献祭|枷锁|倒计时|读秒)/,
    severity: 'blocking',
    fields: NARRATIVE_FIELDS,
  },
  {
    code: 'irreversible-cost',
    label: '不可逆消耗',
    pattern: /(每(用|使用|次)[^，。；]{0,14}(就会|都会)[^，。；]{0,10}(失去|遗忘|折寿|减少|变老))|不可逆/,
    severity: 'blocking',
    fields: NARRATIVE_FIELDS,
  },
  {
    code: 'symmetry-template',
    label: '对称结构模板',
    pattern: /((四段|四份|四种)[^，。；]{0,4}(真心|感情|爱))|(必须在[^，。；]{0,24}的同时)/,
    severity: 'blocking',
    fields: NARRATIVE_FIELDS,
  },
  {
    code: 'moral-closure',
    label: '道德闭环',
    pattern: /(不伤(任何|到)?人|谁都不(会)?受伤|两全其美|不辜负任何人)/,
    severity: 'blocking',
    fields: NARRATIVE_FIELDS,
  },
  {
    code: 'abstract-ending',
    label: '总结升华腔',
    pattern: /(终于明白|这一刻|注定|拉开序幕|悄然|这就是[^，。；]{0,12}的意义)/,
    severity: 'blocking',
    fields: ['premise', 'coreConflict', 'tone', 'sellingPoints'],
  },
  {
    code: 'old-webnovel',
    label: '旧网文套路',
    pattern: /(废柴|赘婿|退婚|重生回|系统说|三年之期|莫欺少年穷|打脸逆袭)/,
    severity: 'warning',
    fields: NARRATIVE_FIELDS,
  },
  {
    code: 'generic-praise',
    label: '空泛评价',
    pattern: /(精彩|好看|感人|热血|治愈|温暖|震撼|炸裂|神作|封神)/,
    severity: 'warning',
    fields: NARRATIVE_FIELDS,
  },
]

const ABSTRACT_WORDS =
  /(成长|救赎|羁绊|命运|真心|执念|温暖|治愈|青春|疼痛|遗憾|孤独|蜕变|勇气|守护|约定|宿命|轮回|因果|羁绊)/g

const CONCRETE_MARKERS: RegExp[] = [
  /\d/,
  /[“”「」"]/,
  /(教室|操场|食堂|便利店|校门|天台|社团|宿舍|家里|路上|公交|地铁|雨|雪|夜|早晨|放学|周末|暑假|游园会|运动会|值日)/,
  /(手机|信封|发票|钥匙|伞|鞋|猫|杯子|饭盒|作业|试卷|球|车|门|窗|桌|椅|零件盒|硬币|颜色)/,
  /[\u4e00-\u9fa5]{2,4}(说|问|喊|看|拿|推|跑|走|坐|站|笑|哭|摸|递|接|按|藏|躲)/,
]

const REPEAT_MARKERS =
  /(每次|每周|每天|每回|每节|每年|又一次|再次|照例|惯例|轮流|轮到|平时|日常|仪式|固定|照旧|老规矩)/

/** 设定档案的字段指纹：出现即说明模型在填表，而不是在写人或写场面 */
const DOSSIER_WORDS = /(功能|缺口|关系标签|口头禅|行为习惯)/g
const ROLE_TAGGED_LINE = /(^|\n)\s*[^\n]{1,16}[（(](主角|反派|配角|女主|男主|男二|女二)[）)]\s*(——|—|:)/g
/** 「麻烦是… / 越界的方式是… / 底线是…」：同一种人物公式反复套 */
const FORMULA_WORDS = /(麻烦是|麻烦在于|越界|底线|软肋|反差萌)/g
/** 名字后堆身份标签：校花·姐姐·邻居 */
const TAG_STACK = /[（(][^）)]{0,40}[·／/][^）)]{0,40}[）)]/g

function lineLengths(text: string): number[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s/g, '').length)
    .filter((n) => n > 0)
}

/** 每条人物都写成差不多长度，是批量生成的典型指纹 */
function hasUniformLines(text: string): boolean {
  const lengths = lineLengths(text)
  if (lengths.length < 3) return false
  const long = lengths.filter((n) => n >= 40)
  if (long.length < 3) return false
  return Math.max(...long) / Math.min(...long) <= 1.8
}

interface DossierSignal {
  words: number
  roleLines: number
  dashes: number
  strong: boolean
  weak: boolean
}

function dossierSignal(text: string): DossierSignal {
  const words = new Set(text.match(DOSSIER_WORDS) ?? []).size
  const roleLines = (text.match(ROLE_TAGGED_LINE) ?? []).length
  const dashes = (text.match(/——/g) ?? []).length
  const strong = words >= 2 || roleLines >= 2 || dashes >= 4
  const weak = !strong && (words === 1 || roleLines === 1 || dashes >= 2)
  return { words, roleLines, dashes, strong, weak }
}

const TURN_MARKERS = /(直到|结果|没想到|却|但|偏偏|反而|突然|就在这时)/

const AXIS_HINTS = /(轻喜|喜剧|搞笑|日常|关系|悬疑|误会|群像|治愈|甜|校园|社团|节日|仪式|单元)/

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const re = new RegExp(pattern.source, flags)
  return (text.match(re) ?? []).length
}

function concreteHits(text: string): number {
  return CONCRETE_MARKERS.reduce((sum, re) => sum + countMatches(text, re), 0)
}

function abstractHits(text: string): number {
  return countMatches(text, ABSTRACT_WORDS)
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export interface TextCritique {
  findings: SeedSuggestionFinding[]
  blocking: number
  warnings: number
  freshness: number
  concrete: number
  abstract: number
}

export function critiqueText(text: string, field: SeedAssistField): TextCritique {
  const findings: SeedSuggestionFinding[] = []
  const t = (text ?? '').trim()
  if (!t) {
    return {
      findings: [{ code: 'empty', message: '建议为空', severity: 'blocking' }],
      blocking: 1,
      warnings: 0,
      freshness: 0,
      concrete: 0,
      abstract: 0,
    }
  }

  for (const rule of CLICHE_RULES) {
    if (rule.fields && !rule.fields.includes(field)) continue
    if (!rule.pattern.test(t)) continue
    findings.push({
      code: rule.code,
      message: `${rule.label}：${t.match(rule.pattern)?.[0] ?? ''}`,
      severity: rule.severity,
    })
  }

  const dossier = dossierSignal(t)
  if (dossier.strong || dossier.weak) {
    const characterField = field === 'characters' || field === 'protagonist'
    if (NARRATIVE_FIELDS.includes(field)) {
      findings.push({
        code: 'dossier-template',
        message: dossier.strong
          ? '人物档案体：字段清单 / 破折号排比，像设定表不像小说'
          : '疑似档案体：用字段清单介绍人物，建议改成场面或台词',
        severity: characterField && dossier.strong ? 'blocking' : 'warning',
      })
    }
  }

  if (field === 'characters' || field === 'protagonist') {
    if (countMatches(t, FORMULA_WORDS) >= 3) {
      findings.push({
        code: 'formula-repeat',
        message: '同一套人物公式反复使用（麻烦 / 越界 / 底线 / 反差萌）',
        severity: 'warning',
      })
    }
    if (countMatches(t, TAG_STACK) >= 2) {
      findings.push({
        code: 'tag-stack',
        message: '名字后堆身份标签，像人物卡',
        severity: 'warning',
      })
    }
    if (hasUniformLines(t)) {
      findings.push({
        code: 'uniform-lines',
        message: '每段长度过于接近，像批量生成的人物卡',
        severity: 'warning',
      })
    }
  }

  const concrete = concreteHits(t)
  const abstract = abstractHits(t)
  // 全是抽象词、没有一个能落地的名词/动作：不可写
  if (abstract >= 2 && concrete === 0) {
    findings.push({
      code: 'abstract-only',
      message: '全是抽象词，没有具体人物、物件或场面',
      severity: 'blocking',
    })
  } else if (abstract > concrete * 2 && abstract >= 3) {
    findings.push({
      code: 'abstract-heavy',
      message: '抽象词明显多于具体信息',
      severity: 'warning',
    })
  }

  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  const dossierPenalty = dossier.strong ? 18 : dossier.weak ? 6 : 0
  const freshness = clamp(
    100 - blocking * 30 - warnings * 12 - dossierPenalty - Math.max(0, abstract - concrete) * 4,
  )

  return { findings, blocking, warnings, freshness, concrete, abstract }
}

function fitScore(field: SeedAssistField, text: string, scene?: string): number {
  const t = text.trim()
  const chars = t.replace(/\s/g, '').length
  const lines = t.split(/\n+/).filter((l) => l.trim())
  switch (field) {
    case 'title': {
      const base = chars >= 4 && chars <= 12 ? 92 : chars >= 2 && chars <= 16 ? 68 : 38
      return clamp(base + (concreteHits(t) > 0 ? 6 : 0))
    }
    case 'genre':
      return clamp(/[/、]/.test(t) ? 88 : /(小说|向|流)/.test(t) ? 74 : 52)
    case 'premise': {
      let score = 48
      if (chars >= 15 && chars <= 120) score += 20
      if (TURN_MARKERS.test(t)) score += 12
      if (concreteHits(t) >= 2) score += 12
      if (scene) score += 8
      return clamp(score)
    }
    case 'coreConflict':
      return clamp(
        50 +
          (/(争|抢|瞒|误会|被迫|不肯|偏要|想|怕)/.test(t) ? 20 : 0) +
          (/(谁|他|她|你|我)/.test(t) ? 12 : 0) +
          (concreteHits(t) > 0 ? 12 : 0),
      )
    case 'protagonist': {
      const dossier = dossierSignal(t)
      return clamp(
        46 +
          (/[“”「」]/.test(t) ? 14 : 0) +
          (/(想|怕|但|却|偏要|不肯|忍不住|嘴上|其实)/.test(t) ? 12 : 0) +
          Math.min(20, concreteHits(t) * 4) -
          (dossier.strong ? 26 : dossier.weak ? 10 : 0) -
          (countMatches(t, FORMULA_WORDS) >= 3 ? 8 : 0),
      )
    }
    case 'characters': {
      const dossier = dossierSignal(t)
      const actionHits = (
        t.match(/[\u4e00-\u9fa5]{1,4}(说|问|喊|笑|推|递|躲|拽|拍|瞪|皱眉|叹气|塞|抢|踢|敲)/g) ?? []
      ).length
      return clamp(
        46 +
          (lines.length >= 2 ? 14 : 6) +
          (/[“”「」]/.test(t) ? 12 : 0) +
          Math.min(16, actionHits * 6) +
          Math.min(16, concreteHits(t) * 4) -
          (dossier.strong ? 28 : dossier.weak ? 12 : 0) -
          (countMatches(t, TAG_STACK) >= 2 ? 10 : 0) -
          (countMatches(t, FORMULA_WORDS) >= 3 ? 8 : 0),
      )
    }
    case 'worldview':
    case 'power': {
      const labeled = /：/.test(t) || /(规则|条件|限制|触发)/.test(t)
      return clamp(44 + (lines.length >= 2 ? 22 : 0) + (labeled ? 20 : 0) + (concreteHits(t) > 0 ? 10 : 0))
    }
    case 'setting':
      return clamp(45 + (/(时代|城市|年代|近未来|古代|现代|校园|高中|大学)/.test(t) ? 30 : 0) + (chars >= 8 ? 15 : 0))
    case 'sellingPoints':
      return clamp(
        42 + (lines.length >= 2 ? 20 : 0) + (concreteHits(t) >= 2 ? 25 : concreteHits(t) > 0 ? 12 : 0),
      )
    case 'tone':
      return clamp(48 + (/[/、]/.test(t) ? 22 : 0) + (chars <= 40 ? 16 : 0))
    case 'references':
      return clamp(48 + (/《/.test(t) ? 24 : 0) + (/(机制|节奏|氛围|群像)/.test(t) ? 18 : 0))
    case 'taboos':
      return clamp(48 + (lines.length >= 2 ? 22 : 0) + (/(不|禁止|避免|不要)/.test(t) ? 18 : 0))
    default:
      return 60
  }
}

export function scoreSuggestion(item: SeedSuggestion, field: SeedAssistField): SeedSuggestionScore {
  const critique = critiqueText(item.text, field)
  const concrete = critique.concrete
  const writability = clamp(
    42 +
      (item.scene?.trim() ? 22 : 0) +
      Math.min(24, concrete * 6) +
      (abstractHits(item.text) > concrete ? -14 : 0),
  )
  const seriality = clamp(
    38 +
      Math.min(36, countMatches(item.text, REPEAT_MARKERS) * 12) +
      (AXIS_HINTS.test(`${item.axis ?? ''}${item.text}`) ? 14 : 0) +
      (item.functionPositions?.length ? 12 : 0),
  )
  const fit = fitScore(field, item.text, item.scene)
  const overall = clamp(critique.freshness * 0.32 + writability * 0.3 + seriality * 0.2 + fit * 0.18)
  return {
    freshness: critique.freshness,
    writability,
    seriality,
    fit,
    overall,
  }
}

function dedupeFindings(findings: SeedSuggestionFinding[]): SeedSuggestionFinding[] {
  const seen = new Set<string>()
  const out: SeedSuggestionFinding[] = []
  for (const f of findings) {
    const key = `${f.code}:${f.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/** 整份方案体检的输入块：location 用于回指位置，text 为该块的完整内容 */
export interface PlanBlock {
  location: string
  text: string
}

/** 只有长文本字段才做“落点/决策”这类整份检查；书名、类型、基调不适用 */
export const PLAN_CRITIQUE_FIELDS: SeedAssistField[] = [
  'premise',
  'coreConflict',
  'protagonist',
  'characters',
  'worldview',
  'power',
  'sellingPoints',
  'setting',
]

type EndingKind = 'summary' | 'dialogue' | 'question' | 'info' | 'action' | 'image'

const ENDING_LABEL: Record<EndingKind, string> = {
  summary: '总结/决心',
  dialogue: '台词',
  question: '疑问',
  info: '信息揭示',
  action: '动作',
  image: '画面',
}

const ENDING_SUMMARY =
  /(终于明白|明白了|暗下决心|下定决心|发誓|注定|从此|这一刻|拉开序幕|新的开始|命运的齿轮|若有所思|意味深长)/
const ENDING_INFO = /(原来|才发现|才知道|发现|竟是|其实是)/
const ENDING_ACTION =
  /(转身|走开|跑|追|推|关|按|递|塞|拿起|放下|收下|退回|撕|烧|敲|关掉|拉上|坐下|站起|回头|低头|抬头|笑|哭|沉默|停住|推开|按住|挂断|扔|藏)/
const DECISION_MARKERS =
  /(决定|选择|答应|拒绝|不肯|偏要|主动|转身|走开|留下|追上|拦住|堵在|关掉|推开|收下|退回|撕|烧|挂断|拉黑|退出|报名|辞职|退学|搬家|告白|道歉|拉上|组了|组队|立了|定下|约好|约定|改成|换到|换回|抢着|抢先|坚持|让步|把[^，。；]{0,10}(推|塞|递|扔|藏|按|锁|抢|还|放))/

const CONFLICT_KINDS: { label: string; pattern: RegExp }[] = [
  { label: '误会', pattern: /(误会|解释|和好|吃醋|闹掰)/ },
  { label: '外敌', pattern: /(反派|敌人|危机|袭击|追杀|威胁)/ },
  { label: '竞技', pattern: /(比赛|考试|演出|社团|选拔|竞聘)/ },
  { label: '关系', pattern: /(告白|喜欢|恋爱|关系|亲近|疏远|分手)/ },
  { label: '家庭', pattern: /(父母|家人|搬家|转学|抚养|亲戚)/ },
  { label: '规则', pattern: /(规则|能力|代价|限制|禁忌|系统)/ },
]

const STOP_CHARS = new Set([
  ...'的了是在和就都也又还不没有他她它我你们这那一个什么自己起来出来下去过来去上来到着过很太更最里外上下前后中',
])

function trimQuoteMarks(text: string): string {
  return text.replace(/^[「『“"'（(]+/, '').replace(/[」』”"'）)]+$/, '').trim()
}

function lastClause(text: string): string {
  const parts = text
    .trim()
    .split(/[。！!？?\n]+/)
    .map((s) => trimQuoteMarks(s.trim()))
    .filter((s) => s.length >= 2)
  const candidate = parts[parts.length - 1] ?? ''
  if (candidate.length >= 4) return candidate
  const joined = trimQuoteMarks(parts.slice(-2).join('，'))
  return joined.length >= 4 ? joined : text.trim().slice(-24)
}

function classifyEnding(text: string): EndingKind {
  const trimmed = text.trim()
  if (/[？?]\s*$/.test(trimmed)) return 'question'
  if (/[”"』」]\s*$/.test(trimmed)) return 'dialogue'
  const clause = lastClause(trimmed)
  if (ENDING_SUMMARY.test(clause)) return 'summary'
  if (ENDING_INFO.test(clause)) return 'info'
  if (ENDING_ACTION.test(clause)) return 'action'
  return 'image'
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 1
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  if (!mean) return 1
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

function stripMarks(text: string): string {
  return text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
}

function repeatedPhrases(blocks: PlanBlock[]): { phrase: string; locations: string[] }[] {
  if (blocks.length < 3) return []
  const owners = new Map<string, Set<number>>()
  blocks.forEach((block, idx) => {
    const clean = stripMarks(block.text)
    const seen = new Set<string>()
    for (let i = 0; i + 5 <= clean.length; i += 1) {
      const gram = clean.slice(i, i + 5)
      if (seen.has(gram)) continue
      seen.add(gram)
      if ([...gram].every((c) => STOP_CHARS.has(c))) continue
      const hit = owners.get(gram)
      if (hit) hit.add(idx)
      else owners.set(gram, new Set([idx]))
    }
  })
  const hits = [...owners.entries()]
    .filter(([, set]) => set.size >= 3)
    .map(([phrase, set]) => ({ phrase, owners: [...set].sort((a, b) => a - b) }))
  const maximal = hits.filter((hit) => {
    return !hits.some(
      (other) =>
        other.phrase.length > hit.phrase.length &&
        other.phrase.includes(hit.phrase) &&
        other.owners.length === hit.owners.length &&
        other.owners.every((v, i) => v === hit.owners[i]),
    )
  })
  return maximal
    .sort((a, b) => b.phrase.length - a.phrase.length)
    .slice(0, 2)
    .map((hit) => ({ phrase: hit.phrase, locations: hit.owners.map((i) => blocks[i].location) }))
}

function conflictKind(text: string): string | null {
  return CONFLICT_KINDS.find((kind) => kind.pattern.test(text))?.label ?? null
}

function topEntry<K>(counts: Map<K, number>): [K, number] | null {
  let top: [K, number] | null = null
  for (const entry of counts.entries()) {
    if (!top || entry[1] > top[1]) top = entry
  }
  return top
}

/**
 * 整份方案体检：只看块与块之间的关系（落点是否同型、冲突是否单一、
 * 短语是否复制、是否有人做选择），单条内容的问题仍由 critiqueText 负责。
 */
export function critiquePlan(blocks: PlanBlock[]): PlanCritiqueResult {
  const valid = blocks.map((b) => ({ ...b, text: b.text.trim() })).filter((b) => b.text)
  const n = valid.length
  if (!n) {
    return {
      score: 0,
      findings: [],
      metrics: { blockCount: 0, decisionDensity: 0, endingVariety: 0, repeatedPhraseCount: 0, avgChars: 0 },
    }
  }

  const findings: SeedSuggestionFinding[] = []
  const endings = valid.map((b) => classifyEnding(b.text))
  const endingCounts = new Map<EndingKind, number>()
  endings.forEach((kind) => endingCounts.set(kind, (endingCounts.get(kind) ?? 0) + 1))
  const topEnding = topEntry(endingCounts)

  const summaryBlocks = valid.filter((_, i) => endings[i] === 'summary')
  if (n >= 2 && summaryBlocks.length >= 2 && summaryBlocks.length / n >= 0.4) {
    findings.push({
      code: 'plan-ending-summary',
      message: `${n} 个落点里有 ${summaryBlocks.length} 个停在总结或决心上`,
      severity: summaryBlocks.length / n >= 0.5 ? 'blocking' : 'warning',
      location: summaryBlocks.map((b) => b.location).slice(0, 3).join(' / '),
      evidence: lastClause(summaryBlocks[0].text),
      suggestion: '把落点改回当时的动作、台词或信息，删掉总结句',
    })
  }

  if (n >= 3 && topEnding && topEnding[0] !== 'summary' && topEnding[1] / n >= 0.75) {
    const hit = valid.find((_, i) => endings[i] === topEnding[0])
    findings.push({
      code: 'plan-ending-monotony',
      message: `${n} 个落点里有 ${topEnding[1]} 个都是「${ENDING_LABEL[topEnding[0]]}」`,
      severity: 'warning',
      location: valid
        .filter((_, i) => endings[i] === topEnding[0])
        .map((b) => b.location)
        .slice(0, 3)
        .join(' / '),
      evidence: hit ? lastClause(hit.text) : undefined,
      suggestion: '至少两块换一种落点：台词、信息揭示、未完成动作或误会',
    })
  }

  const lengths = valid.map((b) => b.text.replace(/\s/g, '').length)
  const cv = coefficientOfVariation(lengths)
  if (n >= 3 && cv < 0.12 && Math.max(...lengths) >= 60) {
    findings.push({
      code: 'plan-beat-uniform',
      message: `每块长度都集中在 ${Math.min(...lengths)}–${Math.max(...lengths)} 字，节奏过于整齐`,
      severity: 'warning',
      location: valid.map((b) => b.location).slice(0, 3).join(' / '),
      evidence: `${Math.min(...lengths)}–${Math.max(...lengths)} 字`,
      suggestion: '让长短错开：一块短促收尾，一块展开到具体场面',
    })
  }

  const openings = valid.map((b) => stripMarks(b.text).slice(0, 6)).filter((s) => s.length === 6)
  const openingCounts = new Map<string, number>()
  openings.forEach((s) => openingCounts.set(s, (openingCounts.get(s) ?? 0) + 1))
  const topOpening = topEntry(openingCounts)
  if (n >= 3 && topOpening && topOpening[1] >= 3) {
    findings.push({
      code: 'plan-opening-repeat',
      message: `${topOpening[1]} 个块用同一句开头`,
      severity: 'warning',
      location: valid
        .filter((b) => stripMarks(b.text).slice(0, 6) === topOpening[0])
        .map((b) => b.location)
        .slice(0, 3)
        .join(' / '),
      evidence: topOpening[0],
      suggestion: '换开头：从人物动作、一个物件或一句台词切入',
    })
  }

  const kinds = valid.map((b) => conflictKind(b.text)).filter((k): k is string => !!k)
  const kindCounts = new Map<string, number>()
  kinds.forEach((k) => kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1))
  const topKind = topEntry(kindCounts)
  if (n >= 3 && topKind && topKind[1] >= Math.max(3, Math.ceil(n * 0.6))) {
    findings.push({
      code: 'plan-conflict-repeat',
      message: `${n} 个块里有 ${topKind[1]} 个都在写同一种冲突（${topKind[0]}）`,
      severity: 'warning',
      location: valid
        .filter((b) => conflictKind(b.text) === topKind[0])
        .map((b) => b.location)
        .slice(0, 3)
        .join(' / '),
      suggestion: `下一块换一种冲突来源：${CONFLICT_KINDS.map((k) => k.label).filter((l) => l !== topKind[0]).slice(0, 3).join(' / ')}`,
    })
  }

  const dossierBlocks = valid.filter((b) => {
    const signal = dossierSignal(b.text)
    return signal.strong || signal.weak
  })
  if (dossierBlocks.length >= 2) {
    findings.push({
      code: 'plan-dossier-cross',
      message: `${dossierBlocks.length} 个块都在用人物档案体（功能/缺口/关系标签）`,
      severity: 'warning',
      location: dossierBlocks.map((b) => b.location).slice(0, 3).join(' / '),
      evidence: dossierBlocks[0].text.match(DOSSIER_WORDS)?.[0],
      suggestion: '删掉字段标签，改成这个人做的一件事或说的一句话',
    })
  }

  const decisionBlocks = valid.filter((b) => DECISION_MARKERS.test(b.text))
  const decisionDensity = +(decisionBlocks.length / n).toFixed(2)
  if (n >= 3 && decisionDensity < 0.5) {
    const passive = valid.filter((b) => !DECISION_MARKERS.test(b.text))
    findings.push({
      code: 'plan-decision-sparse',
      message: `${n} 个块里只有 ${decisionBlocks.length} 个出现了角色做选择`,
      severity: 'warning',
      location: passive.map((b) => b.location).slice(0, 3).join(' / '),
      evidence: lastClause(passive[0]?.text ?? ''),
      suggestion: '补一个选择：谁做了什么，关系、信息或局面因此改变',
    })
  }

  const repeated = repeatedPhrases(valid)
  for (const hit of repeated) {
    findings.push({
      code: 'plan-repeated-phrase',
      message: `同一短语在 ${hit.locations.length} 个位置重复：「${hit.phrase}」`,
      severity: 'warning',
      location: hit.locations.slice(0, 3).join(' / '),
      evidence: hit.phrase,
      suggestion: '换掉重复短语，改写其中一处的人物动作或物件',
    })
  }

  const deduped = dedupeFindings(findings)
  const blocking = deduped.filter((f) => f.severity === 'blocking').length
  const warnings = deduped.filter((f) => f.severity === 'warning').length
  const totalChars = lengths.reduce((sum, v) => sum + v, 0)

  return {
    score: clamp(100 - blocking * 18 - warnings * 8),
    findings: deduped,
    metrics: {
      blockCount: n,
      decisionDensity,
      endingVariety: endingCounts.size,
      repeatedPhraseCount: repeated.length,
      avgChars: Math.round(totalChars / n),
    },
  }
}

export interface SeedAssistEvaluation {
  items: SeedSuggestion[]
  summary: PlanEvalSummary
  /** 多条候选之间的同质化检查；单条检查仍在 summary.findings */
  planCritique?: PlanCritiqueResult
}

export function evaluateSuggestions(rawItems: SeedSuggestion[], field: SeedAssistField): SeedAssistEvaluation {
  const items = rawItems.map((item) => {
    const critique = critiqueText(item.text, field)
    return {
      ...item,
      findings: dedupeFindings([...(item.findings ?? []), ...critique.findings]),
      scores: scoreSuggestion(item, field),
    }
  })

  const findings = dedupeFindings(items.flatMap((item) => item.findings ?? []))
  const blocking = findings.filter((f) => f.severity === 'blocking').length
  const warnings = findings.filter((f) => f.severity === 'warning').length
  const totalChars = items.reduce((sum, item) => sum + Math.max(1, item.text.trim().length), 0)
  const abstractTotal = items.reduce((sum, item) => sum + abstractHits(item.text), 0)
  const concreteTotal = items.reduce((sum, item) => sum + concreteHits(item.text), 0)
  const positions = new Set(
    items.flatMap((item) => item.functionPositions ?? []).filter((p) => (FUNCTION_POSITIONS as readonly string[]).includes(p)),
  )
  const axes = new Set(items.map((item) => item.axis?.trim()).filter(Boolean))
  const score = items.length
    ? clamp(items.reduce((sum, item) => sum + (item.scores?.overall ?? 0), 0) / items.length - blocking * 8)
    : 0

  const planCritique =
    items.length >= 2 && PLAN_CRITIQUE_FIELDS.includes(field)
      ? critiquePlan(
          items.map((item, i) => ({
            location: `候选${i + 1}${item.axis ? ` · ${item.axis}` : ''}`,
            text: item.text,
          })),
        )
      : undefined

  return {
    items,
    summary: {
      score,
      blocking,
      warnings,
      metrics: {
        clicheHits: findings.filter((f) => f.code !== 'abstract-only' && f.code !== 'abstract-heavy').length,
        abstractPct: +((abstractTotal / totalChars) * 100).toFixed(1),
        concretePct: +((concreteTotal / totalChars) * 100).toFixed(1),
        functionPositionCoverage: +(positions.size / FUNCTION_POSITIONS.length).toFixed(2),
        sceneCount: items.filter((item) => item.scene?.trim()).length,
        axisDiversity: items.length ? +(axes.size / items.length).toFixed(2) : 0,
        avgChars: Math.round(totalChars / Math.max(1, items.length)),
      },
      findings,
    },
    planCritique,
  }
}

/** 给 prompt 用的“问题清单”，让模型知道为什么需要重写。 */
export function describeFindings(findings: SeedSuggestionFinding[]): string {
  return findings
    .filter((f) => f.severity !== 'info')
    .map((f) => `- [${f.severity}] ${f.message}`)
    .join('\n')
}
