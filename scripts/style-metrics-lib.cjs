/**
 * 文风度量算法库（IMP-09）
 *
 * 由 _archive/q7~q14.cjs 的验证逻辑固化而来，供两处共用，避免两套实现漂移：
 *   1. scripts/style-check.js（开发期 CLI）
 *   2. electron/services/quality-checker.ts（运行时质检门禁，IMP-05 接入）
 *
 * 基线来源：匿名人工稿完整 30 章（清洗 HTML 后 70192 字）。
 */

// ---------- 基础工具 ----------
const count = (t, re) => (t.match(re) || []).length

const SENT_SPLIT = /[。！？!?…\n]+/
const SUBLIME =
  /(拉开.{0,2}幕|悄悄.{0,4}亮起来|注定|这就是.{0,10}的意义|没有人知道|某种看不见|缓缓落下帷幕|从此.{0,6}不同)/
const CLIMATE = /[雨湿潮]/
// 比喻双口径（2026-10-04，q22 终验发现）：
// - 全量口径（原口径，门禁沿用）：像/仿佛/如同/似的/宛如/犹如/一般 全部计数
// - 修辞口径（strict）：扣除揣测用法——"好像"在现代汉语里几乎只作揣测副词；
//   "像(是)+怕/只是/在/要/想起/忘了/被/有点/不太/问/说"是对场景的猜测而非修辞本体。
//   strict 仍偏保守（个别真修辞如"像在等老师提问"会被计入揣测），仅作参考读数，
//   门禁判定维持全量口径，避免放水。
const SIMILE_ALL = /(像|仿佛|如同|似的|宛如|犹如|一般)/g
const SIMILE_HEDGE = /(好像|像(?:是)?(?=怕|只是|在|要|想起|忘了|被|有点|不太|问|说))/g
// 对话：限制单行、限制长度，避免跨段误匹配
const DLG = /[“”"「][^“”"」\n]{1,80}[”"」]/g

/** HTML 清洗：源稿带 </p><p> 等污染时使用（原文件已备份于 _archive/human-backup） */
function cleanHtml(raw) {
  let t = raw
  t = t.replace(/<div[^>]*>/gi, '')
  t = t.replace(/<\/div>/gi, '')
  t = t.replace(/<\/p>\s*<p>/gi, '\n')
  t = t.replace(/<p[^>]*>/gi, '')
  t = t.replace(/<\/p>/gi, '')
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  t = t.replace(/[ \t]+$/gm, '')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim() + '\n'
}

const paragraphs = (t) =>
  t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)

const sentences = (t) =>
  t.split(SENT_SPLIT).map((s) => s.replace(/\s/g, '')).filter((s) => s.length > 1)

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

// ---------- 单篇指标 ----------
/**
 * @param {string} rawText
 * @param {{excludeNames?: string[]}} opts 排除词表（角色名等）：
 *   角色名含"雨/湿/潮"字时（如名字中带"雨"）字级气候词统计会全量误报，
 *   统计前先从文本中剔除这些名字（q22 终验实证：AI 稿 9 处"雨"全部来自人名）。
 */
function computeMetrics(rawText, opts = {}) {
  const t = rawText || ''
  const chars = t.replace(/\s/g, '').length
  const P = paragraphs(t)
  const S = sentences(t)
  const dlg = (t.match(DLG) || []).map((s) => s.replace(/[“”"「」]/g, '').length)

  const paraLens = P.map((p) => p.length)
  const sentLens = S.map((s) => s.length)
  const excludeNames = Array.isArray(opts.excludeNames) ? opts.excludeNames.filter(Boolean) : []
  const climateText = excludeNames.length ? excludeNames.reduce((acc, n) => acc.split(n).join(''), t) : t
  const climateHits = count(climateText, new RegExp(CLIMATE, 'g'))
  const climateExcluded = excludeNames.length ? count(t, new RegExp(CLIMATE, 'g')) - climateHits : 0
  const simileHits = count(t, SIMILE_ALL)
  const simileHedgeHits = count(t, SIMILE_HEDGE)
  const simileStrictHits = Math.max(simileHits - simileHedgeHits, 0)

  return {
    chars,
    paragraph: {
      count: P.length,
      avgLen: +mean(paraLens).toFixed(1),
      maxLen: paraLens.length ? Math.max(...paraLens) : 0,
      pctOver100: P.length ? +((paraLens.filter((x) => x > 100).length / P.length) * 100).toFixed(1) : 0,
    },
    sentence: {
      count: S.length,
      avgLen: +mean(sentLens).toFixed(1),
      pctOver60: S.length ? +((sentLens.filter((x) => x > 60).length / S.length) * 100).toFixed(1) : 0,
    },
    similePer1k: chars ? +(simileHits / (chars / 1000)).toFixed(2) : 0,
    simileHits,
    simileStrictPer1k: chars ? +(simileStrictHits / (chars / 1000)).toFixed(2) : 0,
    simileStrictHits,
    simileHedgeHits,
    quotes: {
      curly: count(t, /[“”]/g),
      corner: count(t, /[「」]/g),
      straight: count(t, /"/g),
    },
    dashCount: count(t, /——/g),
    climatePer1k: chars ? +(climateHits / (chars / 1000)).toFixed(2) : 0,
    climateHits,
    climateExcluded,
    dialogue: {
      count: dlg.length,
      avgLen: +mean(dlg).toFixed(1),
      pctShort: dlg.length ? +((dlg.filter((x) => x <= 15).length / dlg.length) * 100).toFixed(1) : 0,
    },
    behaviorVsEmotion: +(
      count(t, /(后退|低头|别过|攥|咬|抿|摸了摸|揉|搓|抓|眨|咽|深吸|愣|顿住|僵)/g) /
      Math.max(
        count(t, /(感到|觉得|心里)?(有些|有点|一阵|一丝)?(害怕|紧张|心动|失落|开心|难过|委屈|期待|尴尬|不安|愧疚|慌张|心软)/g),
        1
      )
    ).toFixed(2),
    // 章末升华（需外部传入本章最后一句，或由此函数自行取）
    chapterEndSublime: (() => {
      const last = P[P.length - 1] || ''
      return SUBLIME.test(last)
    })(),
  }
}

// ---------- 门禁阈值（来自分析报告第十二部分验收标准） ----------
/**
 * 分级原则（重要）：
 * blocking = 零歧义硬伤（出现即错，人工稿也不可能命中）：引号混用、章末升华；
 * warning  = 密度/规模类指标（人工稿自身也有个别章超标，硬拦会误杀）。
 *
 * 实测校准：把比喻密度设为 blocking 时，人工稿 30 章有 9 章被拦（如第9章 1.4/千字），
 * 因此密度类一律降为 warning。判定"是否可发布"只看 blocking 是否为 0。
 */
const THRESHOLDS = {
  similePer1k: { max: 1.2, level: 'warning', label: '比喻密度(每千字)' },
  cornerQuote: { max: 0, level: 'blocking', label: '直角引号「」' },
  straightQuote: { max: 0, level: 'blocking', label: '英文直引号' },
  chapterEndSublime: { max: 0, level: 'blocking', label: '章末升华' },
  dashPerChapter: { max: 1, level: 'warning', label: '破折号(每章)' },
  climatePer1k: { max: 0.5, level: 'warning', label: '气候词(每千字)' },
  pctOver100: { max: 5, level: 'warning', label: '超100字段落占比%' },
  pctOver60: { max: 20, level: 'warning', label: '超60字长句占比%' },
  minChars: { min: 2000, level: 'warning', label: '单章字数下限' },
}

/**
 * 单章门禁判定。
 * 返回 { blocking: [...], warnings: [...] }——分级设计避免密度类指标误杀正常表达。
 */
function gateChapter(metrics, thresholds = THRESHOLDS) {
  const blocking = []
  const warnings = []
  const check = (key, value) => {
    const rule = thresholds[key]
    if (!rule) return
    if (rule.max !== undefined && value > rule.max) {
      ;(rule.level === 'blocking' ? blocking : warnings).push(
        `${rule.label}: ${value} > ${rule.max}`
      )
    }
    if (rule.min !== undefined && value < rule.min) {
      ;(rule.level === 'blocking' ? blocking : warnings).push(
        `${rule.label}: ${value} < ${rule.min}`
      )
    }
  }

  check('similePer1k', metrics.similePer1k)
  check('cornerQuote', metrics.quotes.corner)
  check('straightQuote', metrics.quotes.straight)
  check('chapterEndSublime', metrics.chapterEndSublime ? 1 : 0)
  check('dashPerChapter', metrics.dashCount)
  check('climatePer1k', metrics.climatePer1k)
  check('pctOver100', metrics.paragraph.pctOver100)
  check('pctOver60', metrics.sentence.pctOver60)
  check('minChars', metrics.chars)
  return { blocking, warnings }
}

/** 与人工稿基线对照（仅用于报告展示，不作为判定） */
function compareToBaseline(metrics, baseline) {
  if (!baseline) return null
  const b = baseline.metrics || baseline
  return {
    chars: { value: metrics.chars, baseline: b.chars ?? b.章字数均值 },
    paragraphAvg: { value: metrics.paragraph.avgLen, baseline: b.paragraph?.avgLen ?? b.段均长 },
    sentenceAvg: { value: metrics.sentence.avgLen, baseline: b.sentence?.avgLen ?? b.句均长 },
    similePer1k: { value: metrics.similePer1k, baseline: b.similePer1k ?? b.比喻每千字 },
    dash: { value: metrics.dashCount, baseline: b.dashCount ?? b.破折号每章 },
    climatePer1k: { value: metrics.climatePer1k, baseline: b.climatePer1k },
    dialogueAvg: { value: metrics.dialogue.avgLen, baseline: b.dialogue?.avgLen ?? b.对话均长 },
  }
}

module.exports = {
  cleanHtml,
  computeMetrics,
  gateChapter,
  compareToBaseline,
  THRESHOLDS,
  SUBLIME,
}
