#!/usr/bin/env node
/**
 * 文风度量 CLI（IMP-09）
 *
 * 用法：
 *   node scripts/style-check.js <文件或目录> [--json] [--baseline <file>]
 *   node scripts/style-check.js <目录> --rebaseline       # 用该目录重建人工稿基线
 *   --exclude-names=角色甲,角色乙                          # 气候词统计剔除角色名（人名含"雨/湿/潮"时防误报）
 *
 * 基线（人工稿完整 30 章）存于 scripts/baseline-human.json——
 * 注意：不要放在 _archive/，该目录已被 .gitignore 忽略，基线是资产必须入库。
 */

const fs = require('fs')
const path = require('path')
const lib = require('./style-metrics-lib.cjs')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const target = args.find((a) => !a.startsWith('--'))
// 角色名排除（气候词防误报）：--exclude-names=角色甲,角色乙
const excludeNames = (args
  .filter((a) => a.startsWith('--exclude-names='))
  .map((a) => a.slice('--exclude-names='.length))
  .join(',')
  .split(/[,，]/)
  .map((s) => s.trim())
  .filter(Boolean))
const METRICS_OPTS = excludeNames.length ? { excludeNames } : {}
const BASELINE_PATH = path.join(__dirname, 'baseline-human.json')

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    return null
  }
}

/** 把输入拆成章：md 按 `### ` 分章；目录按文件分章 */
function collectChapters(targetPath) {
  const isDir = fs.statSync(targetPath).isDirectory()
  if (isDir) {
    const files = fs
      .readdirSync(targetPath)
      .filter((f) => (f.endsWith('.txt') || f.endsWith('.md')) && !/简介|说明|README/i.test(f))
      .sort()
    return files.map((f) => ({
      title: f.replace(/\.(txt|md)$/, ''),
      text: fs.readFileSync(path.join(targetPath, f), 'utf8'),
    }))
  }
  const raw = fs.readFileSync(targetPath, 'utf8')
  // 丢弃首个 `### ` 之前的内容（书名、简介等），否则会被当成一个"超短章"污染汇总
  const first = raw.match(/^### /m)
  const body = first ? raw.slice(first.index) : raw
  const parts = body.split(/^### /m).filter((s) => s.trim())
  if (parts.length > 1) {
    return parts.map((s) => ({
      title: s.split('\n')[0].trim().slice(0, 40),
      text: s,
    }))
  }
  return [{ title: path.basename(targetPath), text: raw }]
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

function runCheck(targetPath) {
  const chapters = collectChapters(targetPath)
  const baseline = readBaseline()
  const rows = chapters.map((ch) => {
    const m = lib.computeMetrics(ch.text, METRICS_OPTS)
    const gate = lib.gateChapter(m)
    return { title: ch.title, metrics: m, gate }
  })

  const allChars = rows.map((r) => r.metrics.chars)
  const agg = {
    chapters: rows.length,
    charsMean: Math.round(mean(allChars)),
    charsMin: Math.min(...allChars),
    charsMax: Math.max(...allChars),
    similePer1k: +mean(rows.map((r) => r.metrics.similePer1k)).toFixed(2),
    simileStrictPer1k: +mean(rows.map((r) => r.metrics.simileStrictPer1k)).toFixed(2),
    dashPerChapter: +mean(rows.map((r) => r.metrics.dashCount)).toFixed(2),
    climatePer1k: +mean(rows.map((r) => r.metrics.climatePer1k)).toFixed(2),
    cornerQuotes: rows.reduce((a, r) => a + r.metrics.quotes.corner, 0),
    straightQuotes: rows.reduce((a, r) => a + r.metrics.quotes.straight, 0),
    sublimeChapters: rows.filter((r) => r.metrics.chapterEndSublime).length,
    blockingChapters: rows.filter((r) => r.gate.blocking.length).length,
  }

  if (has('--json')) {
    console.log(JSON.stringify({ target: targetPath, aggregate: agg, rows, baseline }, null, 2))
    return
  }

  console.log(`\n=== 文风检查: ${targetPath} ===`)
  console.log(`章数=${agg.chapters}  基线=${baseline ? baseline.source : '（无基线，先跑 --rebaseline）'}`)
  for (const r of rows) {
    const m = r.metrics
    console.log(
      `\n[${r.title}] 字数=${m.chars} 段均=${m.paragraph.avgLen} 句均=${m.sentence.avgLen} ` +
        `比喻/千字=${m.similePer1k}(修辞口径=${m.simileStrictPer1k}) 破折号=${m.dashCount} ` +
        `气候/千字=${m.climatePer1k}${m.climateExcluded ? `（人名剔除${m.climateExcluded}处）` : ''} ` +
        `引号(弯/直角/英)=${m.quotes.curly}/${m.quotes.corner}/${m.quotes.straight} ` +
        `对话均长=${m.dialogue.avgLen} 章末升华=${m.chapterEndSublime ? '是' : '否'}`
    )
    for (const b of r.gate.blocking) console.log(`   ❌ blocking: ${b}`)
    for (const w of r.gate.warnings) console.log(`   ⚠️  warning : ${w}`)
    if (!r.gate.blocking.length && !r.gate.warnings.length) console.log('   ✅ 全部指标通过')
  }

  console.log('\n=== 汇总 ===')
  console.log(`   单章字数: 均值=${agg.charsMean} 区间=${agg.charsMin}~${agg.charsMax}`)
  console.log(
    `   比喻/千字=${agg.similePer1k}(修辞口径=${agg.simileStrictPer1k})  ` +
      `破折号/章=${agg.dashPerChapter}  气候/千字=${agg.climatePer1k}`
  )
  console.log(`   直角引号合计=${agg.cornerQuotes}  英文引号合计=${agg.straightQuotes}`)
  console.log(`   章末升华章数=${agg.sublimeChapters}/${agg.chapters}  blocking 章数=${agg.blockingChapters}`)

  if (baseline) {
    const b = baseline.metrics
    console.log('\n=== 人工稿基线对照 ===')
    const cmp = (label, v, base) => console.log(`   ${label}: 当前=${v}  基线=${base}`)
    cmp('单章字数', agg.charsMean, b.chars)
    cmp('比喻/千字', agg.similePer1k, b.similePer1k)
    cmp('破折号/章', agg.dashPerChapter, b.dashPerChapter)
    cmp('气候/千字', agg.climatePer1k, b.climatePer1k)
    cmp('章末升华率', `${agg.sublimeChapters}/${agg.chapters}`, b.chapterEndSublimeRate)
  }
}

function runRebaseline(targetPath) {
  const chapters = collectChapters(targetPath)
  const corpus = chapters.map((c) => c.text).join('\n')
  const m = lib.computeMetrics(corpus)
  const lens = chapters.map((c) => lib.computeMetrics(c.text).chars)
  const mu = mean(lens)
  const std = Math.sqrt(mean(lens.map((x) => (x - mu) ** 2)))
  const sorted = lens.slice().sort((a, b) => a - b)
  const sublime = chapters.filter((c) => lib.computeMetrics(c.text).chapterEndSublime).length

  const baseline = {
    source: `匿名人工稿基线（${chapters.length} 章）`,
    generatedAt: new Date().toISOString(),
    chapters: chapters.map((c, i) => ({ title: c.title, chars: lens[i] })),
    metrics: {
      chars: Math.round(mu),
      chapterCharsCV: +((std / mu) * 100).toFixed(1),
      charsMin: Math.min(...lens),
      charsMax: Math.max(...lens),
      p10: sorted[Math.floor(sorted.length * 0.1)],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p90: sorted[Math.floor(sorted.length * 0.9)],
      paragraph: m.paragraph,
      sentence: m.sentence,
      similePer1k: m.similePer1k,
      quotes: m.quotes,
      dashPerChapter: +(m.dashCount / chapters.length).toFixed(2),
      climatePer1k: m.climatePer1k,
      dialogue: m.dialogue,
      behaviorVsEmotion: m.behaviorVsEmotion,
      chapterEndSublimeRate: `${sublime}/${chapters.length}`,
    },
  }

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), 'utf8')
  console.log(`基线已写入 ${BASELINE_PATH}`)
  console.log(JSON.stringify(baseline.metrics, null, 1))
}

if (!target) {
  console.error(
    '用法: node scripts/style-check.js <文件或目录> [--json] [--rebaseline] [--exclude-names=名1,名2]'
  )
  process.exit(1)
}
const abs = path.resolve(target)
if (has('--rebaseline')) runRebaseline(abs)
else runCheck(abs)
