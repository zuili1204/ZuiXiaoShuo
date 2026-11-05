// 文风定量指标：与 scripts/style-metrics-lib.cjs 同口径的 TS 实现，供画像分析与生成后评估使用。
// 门禁仍使用 cjs 版本（主进程 quality:check）；2.0 新增的节奏/章节工程/具体度指标只在这里计算。
// 新增字段不改变既有字段口径，因此不影响门禁判定。

import type { StyleAxes } from './style-types'

export const STYLE_METRIC_VERSION = 'p2-2.0'

export type StyleOpeningType = 'dialogue' | 'continuation' | 'time' | 'question' | 'narrative'
export type StyleEndingType = 'image' | 'dialogue' | 'action' | 'question' | 'summary' | 'other'

export interface StyleMetrics {
  chars: number
  sentenceCount: number
  sentenceAvgLen: number
  shortSentencePct: number
  longSentencePct: number
  paragraphCount: number
  paragraphAvgLen: number
  dialogueChars: number
  dialogueCount: number
  dialoguePct: number
  dialogueAvgLen: number
  shortReplyPct: number
  similePer1k: number
  simileStrictPer1k: number
  dashCount: number
  interiorityPct: number
  sensoryPer1k: number
  colloquialPct: number
  infoHookPer1k: number
  hookEnding: boolean

  // 节奏指纹（2.0）
  ellipsisCount: number
  questionCount: number
  exclaimCount: number
  shortParagraphCount: number
  parentheticalCount: number

  // 章节工程（2.0）
  openingType: StyleOpeningType
  endingLen: number
  endingType: StyleEndingType

  // 具体度与引擎（2.0）
  concreteObjectHits: number
  explanationCount: number
  publicEventHits: number
  resetHits: number

  // 禁忌（2.0）
  tabooHits: number
}

const SENT_SPLIT = /[。！？!?…\n]+/
const SIMILE_ALL = /(像|仿佛|如同|似的|宛如|犹如|一般)/g
const SIMILE_HEDGE = /(好像|像(?:是)?(?=怕|只是|在|要|想起|忘了|被|有点|不太|问|说))/g
const DLG = /[“”"「][^“”"」\n]{1,80}[”"」]/g
const INTERIOR = /(心想|心里|心中|暗自|默默|觉得|感到|意识到|想起|回忆|害怕|紧张|心动|失落|难过|委屈|期待|尴尬|不安|愧疚|慌张|心软)/g
const SENSORY = /(看见|听到|闻到|触到|摸到|尝到|声音|气味|香味|寒意|温热|冰凉|刺眼|昏暗|pungent|腥|甜|苦|疼|痛)/g
const COLLOQUIAL = /(呗|嘛|哟|哈|嘿|唉|哎呀|啊|呢|吧|啦|咯|嗯)/g
const HOOK_CUE = /(却|竟|原来|但是|可是|忽然|突然|竟然|没想到|不料|谁知|偏偏)/g
const HOOK_END = /[？！?!…](?:[”"」』）)]*)$/

const ELLIPSIS = /…+/g
const QUESTION = /[？?]/g
const EXCLAIM = /[！!]/g
const PARENTHETICAL = /（[^（）]{1,40}）|\([^()]{1,40}\)/g
// 解释性叙述：设定说明书、因果解释、总结句的常见标记
const EXPLANATION = /(也就是说|换句话说|这意味着|原因是|因为|所以|因此|规则是|指的是|实际上|本质上)/g
// 苦情/闭环模板：作品“不写什么”的量化对照
const TABOO = /(代价是|代价|枷锁|倒计时|宿命|献祭|必须选择|唯一的办法|注定)/g
// 公共事件：所有人必须到场的日历节点
const PUBLIC_EVENT = /(运动会|升旗|家长会|班会|晚会|元旦|春节|期末|期中|考试|研学|春游|秋游|军训|校庆|比赛|演出|值日|换位|分班|开学|毕业)/g
// 制度重置：让关系可以重来的节点
const RESET = /(换位|分班|开学|放假|搬家|升学|毕业|调岗|跳槽)/g
// 具体物件：用词具体度的保守近似（宁缺毋滥，仅统计高辨识度名词）
const CONCRETE_OBJECT = /(手机|书包|硬币|雨伞|水杯|钥匙|纸条|校服|围巾|耳机|饭卡|粉笔|黑板|课桌|椅子|楼梯|公交|单车|奶茶|关东煮|便利贴|橡皮|铅笔|试卷|作业本|篮球|足球|球拍|镜子|发圈|眼镜|口罩|手表|钱包|易拉罐|纸箱|塑料袋|饭盒|筷子|勺子|纸巾|创可贴|雨衣|手套|帽子|外套|鞋子|课本|钢笔|贴纸|信封|相片|日历|闹钟|台灯|插座|窗帘|毯子|枕头|水壶|饮料|零食|面包|牛奶|苹果|橘子|糖果|蛋糕|鲜花|气球|彩带|奖状|锦旗|红领巾|校徽|胸牌|班牌|值日表|座位表)/g

const DIALOGUE_START = /^[“"「『]/
const TIME_START = /^(清晨|深夜|傍晚|凌晨|那天|这天|第二天|次日|周一|周末|放学|上课|下课|中午|早晨|晚上|多年后|小时候|开学|放学后)/
const CONTINUATION_START = /^(他|她|它|他们|她们|我|你|您|这|那|于是|然后|接着|这时|此时|可|但|而|所以|不过|说完|话落)/
const ACTION_VERBS = /(走|跑|站|坐|推|拉|抬|低|转|握|放|看|听|笑|喊|问|答|挤|撞|躲|追|停|靠|趴|蹲|跳|扔|递|接|拍|敲|踢|抱|背|扶|拽|摸|擦|翻|关|开)/
const SUMMARY_ENDING = /(从此|终于明白|终于知道|他知道|她知道|所谓|这就是.{0,8}的意义|仿佛在说|一切都|再也没有|也许这就是|或许这就是)/
const SUBLIME_ENDING = /(命运|宿命|成长|青春|救赎|时光|岁月|注定|永恒)/

const count = (text: string, re: RegExp) => (text.match(re) || []).length
const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
const pct = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0)
const per1k = (part: number, chars: number) => (chars ? +((part / chars) * 1000).toFixed(2) : 0)

function median(arr: number[]): number {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stripPunct(text: string): string {
  return text.replace(/[\s。！？!?…，,、；;：:“”"「」『』（）()]/g, '')
}

export function classifyOpening(firstParagraph: string): StyleOpeningType {
  const first = (firstParagraph || '').trim()
  if (!first) return 'narrative'
  if (DIALOGUE_START.test(first)) return 'dialogue'
  if (TIME_START.test(first)) return 'time'
  const firstSentence = first.split(/[。！？!?…]/)[0] ?? first
  if (/[？?]\s*$/.test(firstSentence)) return 'question'
  if (CONTINUATION_START.test(first)) return 'continuation'
  return 'narrative'
}

export function classifyEnding(lastParagraph: string): StyleEndingType {
  const last = (lastParagraph || '').trim()
  if (!last) return 'other'
  if (DIALOGUE_START.test(last)) return 'dialogue'
  if (/[？?]\s*$/.test(last)) return 'question'
  if (SUMMARY_ENDING.test(last) || SUBLIME_ENDING.test(last)) return 'summary'
  if (stripPunct(last).length <= 20) return 'image'
  if (ACTION_VERBS.test(last)) return 'action'
  return 'other'
}

export function computeStyleMetrics(raw: string): StyleMetrics {
  const text = raw || ''
  const chars = text.replace(/\s/g, '').length
  const paragraphs = text.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
  const sentences = text
    .split(SENT_SPLIT)
    .map((s) => s.replace(/\s/g, ''))
    .filter((s) => s.length > 1)
  const dialogue = (text.match(DLG) || []).map((s) => s.replace(/[“”"「」]/g, ''))

  const sentenceLens = sentences.map((s) => s.length)
  const dialogueLens = dialogue.map((d) => d.length)
  const dialogueChars = dialogueLens.reduce((a, b) => a + b, 0)
  const simileHits = count(text, SIMILE_ALL)
  const simileHedge = count(text, SIMILE_HEDGE)
  const simileStrict = Math.max(simileHits - simileHedge, 0)
  const trimmed = text.trim()

  const lastParagraph = paragraphs[paragraphs.length - 1] ?? ''
  const lastSentence =
    lastParagraph
      .split(/[。！？!?…]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() ?? lastParagraph

  return {
    chars,
    sentenceCount: sentences.length,
    sentenceAvgLen: +mean(sentenceLens).toFixed(1),
    shortSentencePct: pct(sentenceLens.filter((n) => n <= 10).length, sentences.length),
    longSentencePct: pct(sentenceLens.filter((n) => n > 60).length, sentences.length),
    paragraphCount: paragraphs.length,
    paragraphAvgLen: +mean(paragraphs.map((p) => p.length)).toFixed(1),
    dialogueChars,
    dialogueCount: dialogue.length,
    dialoguePct: pct(dialogueChars, chars),
    dialogueAvgLen: +mean(dialogueLens).toFixed(1),
    shortReplyPct: pct(dialogueLens.filter((n) => n <= 15).length, dialogue.length),
    similePer1k: per1k(simileHits, chars),
    simileStrictPer1k: per1k(simileStrict, chars),
    dashCount: count(text, /——/g),
    interiorityPct: pct(count(text, INTERIOR), sentences.length),
    sensoryPer1k: per1k(count(text, SENSORY), chars),
    colloquialPct: pct(count(text, COLLOQUIAL), sentences.length),
    infoHookPer1k: per1k(count(text, HOOK_CUE), chars),
    // 句末标点已在分句时被剥离，钩子判断必须看原文末尾
    hookEnding: HOOK_END.test(trimmed),

    ellipsisCount: count(text, ELLIPSIS),
    questionCount: count(text, QUESTION),
    exclaimCount: count(text, EXCLAIM),
    shortParagraphCount: paragraphs.filter((p) => p.length <= 4).length,
    parentheticalCount: count(text, PARENTHETICAL),

    openingType: classifyOpening(paragraphs[0] ?? ''),
    endingLen: stripPunct(lastSentence).length,
    endingType: classifyEnding(lastParagraph),

    concreteObjectHits: count(text, CONCRETE_OBJECT),
    explanationCount: count(text, EXPLANATION),
    publicEventHits: count(text, PUBLIC_EVENT),
    resetHits: count(text, RESET),

    tabooHits: count(text, TABOO),
  }
}

/** 单章正文的“目标轴”视图：单章即一章，章长与破折号按本章计。 */
export function metricsToAxes(m: StyleMetrics): StyleAxes {
  const opening = m.openingType
  return {
    sentenceAvgLen: m.sentenceAvgLen,
    shortSentencePct: round1(m.shortSentencePct),
    longSentencePct: round1(m.longSentencePct),
    paragraphAvgLen: m.paragraphAvgLen,
    dialoguePct: round1(m.dialoguePct),
    dialogueAvgLen: m.dialogueAvgLen,
    shortReplyPct: round1(m.shortReplyPct),
    simileStrictPer1k: m.simileStrictPer1k,
    dashPerChapter: m.dashCount,
    interiorityPct: round1(m.interiorityPct),
    sensoryPer1k: m.sensoryPer1k,
    colloquialPct: round1(m.colloquialPct),
    hookEndingPct: m.hookEnding ? 100 : 0,
    infoHookPer1k: m.infoHookPer1k,
    chapterAvgLen: m.chars,

    ellipsisPerChapter: m.ellipsisCount,
    questionPerChapter: m.questionCount,
    exclaimPerChapter: m.exclaimCount,
    shortParagraphPct: round1(pct(m.shortParagraphCount, m.paragraphCount)),
    parentheticalPerChapter: m.parentheticalCount,

    openingDialoguePct: opening === 'dialogue' ? 100 : 0,
    openingContinuationPct: opening === 'continuation' ? 100 : 0,
    openingInMediaResPct: opening === 'dialogue' || opening === 'continuation' ? 100 : 0,
    endingMedianLen: m.endingLen,
    endingShortImagePct: m.endingType === 'image' ? 100 : 0,
    titleNamePct: 0,
    titleExclaimPct: 0,
    titleQuestionPct: 0,
    titleMultiPartPct: 0,

    concreteObjectPer1k: per1k(m.concreteObjectHits, m.chars),
    explanationPer1k: per1k(m.explanationCount, m.chars),
    publicEventPerChapter: m.publicEventHits > 0 ? 1 : 0,
    resetPerVolume: 0,
    tabooRatio: m.tabooHits > 0 ? 1 : 0,
    characterVoiceDispersion: 0,
  }
}

/** 标题工程：只依赖标题文本与可选的名字表，纯函数。 */
export function computeTitleMetrics(
  titles: string[],
  names: string[] = [],
): { namePct: number; exclaimPct: number; questionPct: number; multiPartPct: number } {
  const rows = titles.map((t) => t.trim()).filter(Boolean)
  const total = rows.length
  if (!total) return { namePct: 0, exclaimPct: 0, questionPct: 0, multiPartPct: 0 }
  const namesHit = names.filter((n) => n.trim().length >= 2)
  return {
    namePct: +pct(
      rows.filter((t) => namesHit.some((n) => t.includes(n))).length,
      total,
    ).toFixed(1),
    exclaimPct: +pct(rows.filter((t) => /[！!]/.test(t)).length, total).toFixed(1),
    questionPct: +pct(rows.filter((t) => /[？?]/.test(t)).length, total).toFixed(1),
    multiPartPct: +pct(rows.filter((t) => /[／/｜|、，,]/.test(t)).length, total).toFixed(1),
  }
}

/**
 * 多章聚合：比率类按字数加权，章节工程类按章计数。
 * 只传入有正文的章节；空数组返回全 0，调用方负责提示样本不足。
 */
export function aggregateStyleMetrics(
  chapters: { content: string; title?: string }[],
  opts: { names?: string[] } = {},
): StyleAxes {
  const rows = chapters
    .map((c) => ({ metrics: computeStyleMetrics(c.content), title: c.title ?? '' }))
    .filter((r) => r.metrics.chars > 0)
  if (!rows.length) return zeroAxes()

  const totalChars = rows.reduce((s, r) => s + r.metrics.chars, 0)
  const totalSentences = rows.reduce((s, r) => s + r.metrics.sentenceCount, 0)
  const totalParagraphs = rows.reduce((s, r) => s + r.metrics.paragraphCount, 0)
  const totalDialogue = rows.reduce((s, r) => s + r.metrics.dialogueCount, 0)
  const n = rows.length
  const weighted = (pick: (m: StyleMetrics) => number) =>
    totalChars ? rows.reduce((s, r) => s + pick(r.metrics) * r.metrics.chars, 0) / totalChars : 0
  const meanPerChapter = (pick: (m: StyleMetrics) => number) =>
    rows.reduce((s, r) => s + pick(r.metrics), 0) / n

  const titles = rows.map((r) => r.title)
  const titleMetrics = computeTitleMetrics(titles, opts.names)
  const resetChapters = rows.filter((r) => r.metrics.resetHits > 0).length
  // 原书没有卷信息；按 30 章/卷估算，仅作节奏指纹参考
  const estimatedVolumes = Math.max(1, Math.ceil(n / 30))

  return {
    sentenceAvgLen: +weighted((m) => m.sentenceAvgLen).toFixed(1),
    shortSentencePct: +pct(rows.reduce((s, r) => s + (r.metrics.shortSentencePct / 100) * r.metrics.sentenceCount, 0), totalSentences).toFixed(1),
    longSentencePct: +pct(rows.reduce((s, r) => s + (r.metrics.longSentencePct / 100) * r.metrics.sentenceCount, 0), totalSentences).toFixed(1),
    paragraphAvgLen: +(totalChars / Math.max(1, totalParagraphs)).toFixed(1),
    dialoguePct: +pct(rows.reduce((s, r) => s + r.metrics.dialogueChars, 0), totalChars).toFixed(1),
    dialogueAvgLen: +(
      rows.reduce((s, r) => s + r.metrics.dialogueAvgLen * r.metrics.dialogueCount, 0) / Math.max(1, totalDialogue)
    ).toFixed(1),
    shortReplyPct: +pct(
      rows.reduce((s, r) => s + (r.metrics.shortReplyPct / 100) * r.metrics.dialogueCount, 0),
      totalDialogue,
    ).toFixed(1),
    simileStrictPer1k: +weighted((m) => m.simileStrictPer1k).toFixed(2),
    dashPerChapter: +meanPerChapter((m) => m.dashCount).toFixed(2),
    interiorityPct: +weighted((m) => m.interiorityPct).toFixed(1),
    sensoryPer1k: +weighted((m) => m.sensoryPer1k).toFixed(2),
    colloquialPct: +weighted((m) => m.colloquialPct).toFixed(1),
    hookEndingPct: +pct(rows.filter((r) => r.metrics.hookEnding).length, n).toFixed(1),
    infoHookPer1k: +weighted((m) => m.infoHookPer1k).toFixed(2),
    chapterAvgLen: Math.round(totalChars / n),

    ellipsisPerChapter: +meanPerChapter((m) => m.ellipsisCount).toFixed(1),
    questionPerChapter: +meanPerChapter((m) => m.questionCount).toFixed(1),
    exclaimPerChapter: +meanPerChapter((m) => m.exclaimCount).toFixed(1),
    shortParagraphPct: +pct(rows.reduce((s, r) => s + r.metrics.shortParagraphCount, 0), totalParagraphs).toFixed(1),
    parentheticalPerChapter: +meanPerChapter((m) => m.parentheticalCount).toFixed(1),

    openingDialoguePct: +pct(rows.filter((r) => r.metrics.openingType === 'dialogue').length, n).toFixed(1),
    openingContinuationPct: +pct(rows.filter((r) => r.metrics.openingType === 'continuation').length, n).toFixed(1),
    openingInMediaResPct: +pct(
      rows.filter((r) => r.metrics.openingType === 'dialogue' || r.metrics.openingType === 'continuation').length,
      n,
    ).toFixed(1),
    endingMedianLen: +median(rows.map((r) => r.metrics.endingLen)).toFixed(1),
    endingShortImagePct: +pct(rows.filter((r) => r.metrics.endingType === 'image').length, n).toFixed(1),
    titleNamePct: titleMetrics.namePct,
    titleExclaimPct: titleMetrics.exclaimPct,
    titleQuestionPct: titleMetrics.questionPct,
    titleMultiPartPct: titleMetrics.multiPartPct,

    concreteObjectPer1k: +weighted((m) => per1k(m.concreteObjectHits, m.chars)).toFixed(2),
    explanationPer1k: +weighted((m) => per1k(m.explanationCount, m.chars)).toFixed(2),
    publicEventPerChapter: +(rows.reduce((s, r) => s + r.metrics.publicEventHits, 0) / n).toFixed(2),
    resetPerVolume: +(resetChapters / estimatedVolumes).toFixed(2),
    tabooRatio: +(rows.filter((r) => r.metrics.tabooHits > 0).length / n).toFixed(3),
    // 角色声音离散度需要 Craft 层的 voice 数据，由分析服务在聚合后回填
    characterVoiceDispersion: 0,
  }
}

export function zeroAxes(): StyleAxes {
  return {
    sentenceAvgLen: 0,
    shortSentencePct: 0,
    longSentencePct: 0,
    paragraphAvgLen: 0,
    dialoguePct: 0,
    dialogueAvgLen: 0,
    shortReplyPct: 0,
    simileStrictPer1k: 0,
    dashPerChapter: 0,
    interiorityPct: 0,
    sensoryPer1k: 0,
    colloquialPct: 0,
    hookEndingPct: 0,
    infoHookPer1k: 0,
    chapterAvgLen: 0,

    ellipsisPerChapter: 0,
    questionPerChapter: 0,
    exclaimPerChapter: 0,
    shortParagraphPct: 0,
    parentheticalPerChapter: 0,

    openingDialoguePct: 0,
    openingContinuationPct: 0,
    openingInMediaResPct: 0,
    endingMedianLen: 0,
    endingShortImagePct: 0,
    titleNamePct: 0,
    titleExclaimPct: 0,
    titleQuestionPct: 0,
    titleMultiPartPct: 0,

    concreteObjectPer1k: 0,
    explanationPer1k: 0,
    publicEventPerChapter: 0,
    resetPerVolume: 0,

    tabooRatio: 0,
    characterVoiceDispersion: 0,
  }
}

function round1(n: number): number {
  return +n.toFixed(1)
}

/** 确定性抽样：首/中/末必含，其余均匀铺开；同输入同输出，便于断点续跑复用。 */
export function sampleChapterIndexes(total: number, count: number, seed = 0): number[] {
  if (total <= 0) return []
  const n = Math.max(1, Math.min(count, total))
  if (n === total) return Array.from({ length: total }, (_, i) => i)
  const picked = new Set<number>([0, total - 1, Math.floor(total / 2)])
  const inner = n - picked.size
  if (inner > 0) {
    const step = total / (inner + 1)
    const offset = seed % Math.max(1, Math.floor(step))
    for (let i = 1; i <= inner; i++) {
      const pos = Math.min(total - 2, Math.max(1, Math.round(i * step) + offset))
      picked.add(pos)
    }
  }
  // 极端小样本：中间点重复时用可用下标补足
  for (let i = 0; picked.size < n && i < total; i++) picked.add(i)
  return [...picked].sort((a, b) => a - b).slice(0, n)
}
