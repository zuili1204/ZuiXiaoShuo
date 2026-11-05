// P4：平台数据的纯函数层（解析 / 趋势 / 异常 / 情绪 / 脱敏），同输入同输出。
import type {
  ChapterAnomaly,
  ChapterMetricInput,
  DailyMetricInput,
  HookComparison,
  PlatformComment,
  SentimentSummary,
  TrendAnalysis,
  TrendPoint,
} from './platform-types'

// ===== CSV 解析 =====

export interface CsvParseResult {
  rows: string[][]
}

/** 支持引号包裹、逗号转义与 BOM；空行忽略。 */
export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = []
  const src = (text || '').replace(/^\uFEFF/, '')
  let field = ''
  let row: string[] = []
  let inQuotes = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== '')) }
}

const DATE_KEYS = ['日期', '时间', 'date', 'day']
const READS_KEYS = ['阅读量', '阅读', '点击量', '点击', 'reads', 'read']
const RATE_KEYS = ['读完率', '完读率', '读完', 'completionrate', 'completion', 'finishrate']
const COMMENT_KEYS = ['评论数', '评论量', '评论', 'comments', 'comment']
const REVENUE_KEYS = ['收益', '收入', '订阅', 'revenue', 'income']
const NAME_KEYS = ['章节名称', '章节名', '章节', 'chapter_name', 'chapter', 'title']
const ORDER_KEYS = ['章节序号', '章序', '序号', 'chapter_order', 'order']
const CONTENT_KEYS = ['评论内容', '评论正文', '评论', '内容', 'comment', 'content', 'text']

function normHeader(h: string): string {
  return (h || '').toLowerCase().replace(/[\s_\-（）()]/g, '')
}

function hasExactHeader(row: string[], keys: string[]): boolean {
  const normalized = row.map(normHeader)
  return keys.some((key) => normalized.includes(normHeader(key)))
}

function findColumn(headers: string[], keys: string[]): number {
  const normalized = headers.map(normHeader)
  for (const key of keys) {
    const idx = normalized.indexOf(normHeader(key))
    if (idx >= 0) return idx
  }
  for (const key of keys) {
    const k = normHeader(key)
    const idx = normalized.findIndex((h) => h.includes(k))
    if (idx >= 0) return idx
  }
  return -1
}

function cell(row: string[], idx: number): string {
  return idx >= 0 ? (row[idx] ?? '') : ''
}

export function parseNumber(raw: string): number {
  const cleaned = (raw || '').replace(/[,，\s¥￥$€]/g, '')
  const m = cleaned.match(/(-?\d+(?:\.\d+)?)([万亿千])?/)
  if (!m) return 0
  const unit = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : m[2] === '千' ? 1e3 : 1
  return Number(m[1]) * unit
}

export function parseCount(raw: string): number {
  return Math.max(0, Math.round(parseNumber(raw)))
}

/** 读完率统一为 0~100；支持 62%、0.62、62。 */
export function parseRate(raw: string): number {
  const text = (raw || '').replace(/[,，\s]/g, '')
  const value = parseNumber(text)
  if (!Number.isFinite(value) || value <= 0) return 0
  const rate = text.includes('%') || value > 1 ? value : value * 100
  return Math.min(100, Math.max(0, Math.round(rate * 100) / 100))
}

export function normalizeDate(raw: string, now = new Date()): string | null {
  const s = (raw || '').trim()
  if (!s) return null
  const build = (y: number, m: number, d: number): string | null => {
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const full = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (full) return build(Number(full[1]), Number(full[2]), Number(full[3]))
  const monthDay = s.match(/^(\d{1,2})[-/.](\d{1,2})$/)
  if (monthDay) return build(now.getFullYear(), Number(monthDay[1]), Number(monthDay[2]))
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return build(Number(compact[1]), Number(compact[2]), Number(compact[3]))
  const parsed = new Date(s)
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
  }
  return null
}

function looksLikeHeader(row: string[]): boolean {
  return findColumn(row, DATE_KEYS) >= 0 || findColumn(row, NAME_KEYS) >= 0
}

export function parseDailyCsv(text: string, now = new Date()): { rows: DailyMetricInput[]; errors: string[] } {
  const { rows } = parseCsv(text)
  const errors: string[] = []
  if (rows.length === 0) return { rows: [], errors: ['文件内容为空'] }

  const hasHeader = looksLikeHeader(rows[0])
  const headers = hasHeader ? rows[0] : []
  const dateIdx = hasHeader ? findColumn(headers, DATE_KEYS) : 0
  const readsIdx = hasHeader ? findColumn(headers, READS_KEYS) : 1
  const rateIdx = hasHeader ? findColumn(headers, RATE_KEYS) : 2
  const commentIdx = hasHeader ? findColumn(headers, COMMENT_KEYS) : 3
  const revenueIdx = hasHeader ? findColumn(headers, REVENUE_KEYS) : 4

  const out: DailyMetricInput[] = []
  const seen = new Set<string>()
  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i]
    const date = normalizeDate(cell(row, dateIdx), now)
    if (!date) {
      errors.push(`第 ${i + 1} 行日期无法识别：${cell(row, dateIdx) || '(空)'}`)
      continue
    }
    if (seen.has(date)) {
      errors.push(`第 ${i + 1} 行日期重复（${date}），已覆盖前一条`)
      const prev = out.findIndex((r) => r.date === date)
      if (prev >= 0) out.splice(prev, 1)
    }
    seen.add(date)
    out.push({
      date,
      reads: parseCount(cell(row, readsIdx)),
      completionRate: parseRate(cell(row, rateIdx)),
      comments: parseCount(cell(row, commentIdx)),
      revenue: Math.max(0, Math.round(parseNumber(cell(row, revenueIdx)) * 100) / 100),
    })
  }
  if (out.length === 0 && errors.length === 0) errors.push('没有可导入的数据行')
  return { rows: out, errors }
}

export function parseChapterCsv(text: string, now = new Date()): { rows: ChapterMetricInput[]; errors: string[] } {
  const { rows } = parseCsv(text)
  const errors: string[] = []
  if (rows.length === 0) return { rows: [], errors: ['文件内容为空'] }

  const hasHeader = looksLikeHeader(rows[0])
  const headers = hasHeader ? rows[0] : []
  const nameIdx = hasHeader ? findColumn(headers, NAME_KEYS) : 0
  const orderIdx = hasHeader ? findColumn(headers, ORDER_KEYS) : 1
  const readsIdx = hasHeader ? findColumn(headers, READS_KEYS) : 2
  const rateIdx = hasHeader ? findColumn(headers, RATE_KEYS) : 3
  const commentIdx = hasHeader ? findColumn(headers, COMMENT_KEYS) : 4
  const revenueIdx = hasHeader ? findColumn(headers, REVENUE_KEYS) : 5
  const dateIdx = hasHeader ? findColumn(headers, DATE_KEYS) : -1

  const out: ChapterMetricInput[] = []
  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i]
    const name = cell(row, nameIdx).trim()
    if (!name) {
      errors.push(`第 ${i + 1} 行缺少章节名`)
      continue
    }
    const orderRaw = cell(row, orderIdx)
    const order = orderRaw ? parseCount(orderRaw) : out.length + 1
    out.push({
      date: dateIdx >= 0 ? (normalizeDate(cell(row, dateIdx), now) ?? '') : '',
      platformChapterName: name,
      platformOrder: order || out.length + 1,
      reads: parseCount(cell(row, readsIdx)),
      completionRate: parseRate(cell(row, rateIdx)),
      comments: parseCount(cell(row, commentIdx)),
      revenue: Math.max(0, Math.round(parseNumber(cell(row, revenueIdx)) * 100) / 100),
    })
  }
  if (out.length === 0 && errors.length === 0) errors.push('没有可导入的数据行')
  return { rows: out, errors }
}

export function parseCommentsCsv(text: string, now = new Date()): { rows: { date: string; platformChapterName: string; content: string }[]; errors: string[] } {
  const { rows } = parseCsv(text)
  const errors: string[] = []
  if (rows.length === 0) return { rows: [], errors: ['文件内容为空'] }

  // 仅按精确表头判断，避免正文里出现“评论”二字被误当成表头
  const hasHeader =
    hasExactHeader(rows[0], CONTENT_KEYS) ||
    hasExactHeader(rows[0], DATE_KEYS) ||
    hasExactHeader(rows[0], NAME_KEYS)
  const headers = hasHeader ? rows[0] : []
  const contentIdx = hasHeader ? findColumn(headers, CONTENT_KEYS) : rows[0].length >= 3 ? 2 : 0
  const dateIdx = hasHeader ? findColumn(headers, DATE_KEYS) : 0
  const nameIdx = hasHeader ? findColumn(headers, NAME_KEYS) : 1

  const out: { date: string; platformChapterName: string; content: string }[] = []
  for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
    const row = rows[i]
    const content = cell(row, contentIdx).trim()
    if (!content) continue
    out.push({
      date: normalizeDate(cell(row, dateIdx), now) ?? '',
      platformChapterName: cell(row, nameIdx).trim(),
      content,
    })
  }
  if (out.length === 0) errors.push('没有可导入的评论内容')
  return { rows: out, errors }
}

// ===== 趋势 =====

function round(value: number, digits = 1): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function average(rows: TrendPoint[], key: keyof Omit<TrendPoint, 'date'>): number {
  if (rows.length === 0) return 0
  return rows.reduce((sum, r) => sum + Number(r[key] || 0), 0) / rows.length
}

export function buildTrend(points: TrendPoint[]): TrendAnalysis {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))
  const n = sorted.length
  const head = sorted.slice(0, Math.min(3, n))
  const tail = sorted.slice(Math.max(0, n - 3))
  const readsDelta = round(average(tail, 'reads') - average(head, 'reads'))
  const completionDelta = round(average(tail, 'completionRate') - average(head, 'completionRate'), 2)
  const commentDelta = round(average(tail, 'comments') - average(head, 'comments'))
  const revenueDelta = round(average(tail, 'revenue') - average(head, 'revenue'), 2)
  const threshold = Math.max(1, average(head, 'reads') * 0.05)
  const direction: TrendAnalysis['direction'] = readsDelta > threshold ? 'up' : readsDelta < -threshold ? 'down' : 'flat'
  const readWord = direction === 'up' ? '上升' : direction === 'down' ? '下降' : '基本持平'
  const rateWord = completionDelta > 0.5 ? '上升' : completionDelta < -0.5 ? '下降' : '基本持平'
  const summary = n === 0
    ? '还没有导入平台数据'
    : `最近 ${n} 天阅读${readWord}（${readsDelta >= 0 ? '+' : ''}${readsDelta}），读完率${rateWord}（${completionDelta >= 0 ? '+' : ''}${completionDelta} 个点）；这是数据观察，不代表因果。`
  return { points: sorted, direction, readsDelta, completionDelta, commentDelta, revenueDelta, summary }
}

// ===== 异常章 =====

export interface ChapterAnomalyInput {
  chapterId: string | null
  chapterTitle: string
  platformChapterName: string
  platformOrder: number
  reads: number
  completionRate: number
  isHookChapter: boolean
  wordCount: number
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 读完率骤降：与相邻章节中位数比较，低于阈值即列为异常；输出可能原因，不下因果结论。 */
export function findCompletionDrops(
  rows: ChapterAnomalyInput[],
  opts: { threshold?: number; limit?: number } = {},
): ChapterAnomaly[] {
  const threshold = opts.threshold ?? 12
  const limit = opts.limit ?? 5
  const valid = rows.filter((r) => r.completionRate > 0)
  if (valid.length < 3) return []

  const globalBaseline = median(valid.map((r) => r.completionRate))
  const candidates: ChapterAnomaly[] = []

  for (const row of valid) {
    const neighbors = valid.filter((o) => o !== row && Math.abs(o.platformOrder - row.platformOrder) <= 2)
    const baseline = neighbors.length >= 2 ? median(neighbors.map((o) => o.completionRate)) : globalBaseline
    const drop = round(baseline - row.completionRate, 2)
    if (drop < threshold) continue

    const previous = valid.find((o) => o.platformOrder === row.platformOrder - 1)
    const causes: string[] = []
    if (row.platformOrder <= 3) causes.push('开篇阶段读者耐心有限，优先检查前 300 字是否出现冲突或悬念')
    if (row.wordCount >= 3500) causes.push(`本章约 ${row.wordCount} 字，篇幅偏长，检查中段是否有重复解释或旁支`)
    if (previous && previous.completionRate - row.completionRate >= threshold) {
      causes.push('掉点集中在本章开头，优先检查与上一章的衔接是否断了悬念')
    }
    if (row.isHookChapter) causes.push('本章挂了钩子但读完率反而偏低，检查钩子是否在上章已透支，或与正文关系不强')
    if (row.completionRate < 30) causes.push('整章留存偏低，先检查章首承接与章末追读点')
    if (causes.length === 0) causes.push('检查章首 200 字是否承接上章悬念、章末是否有明确追读点')

    candidates.push({
      chapterId: row.chapterId,
      chapterTitle: row.chapterTitle,
      platformChapterName: row.platformChapterName,
      platformOrder: row.platformOrder,
      reads: row.reads,
      completionRate: row.completionRate,
      baseline: round(baseline, 2),
      drop,
      isHookChapter: row.isHookChapter,
      wordCount: row.wordCount,
      possibleCauses: causes.slice(0, 3),
    })
  }

  return candidates.sort((a, b) => b.drop - a.drop).slice(0, limit)
}

// ===== 评论情绪 =====

const POSITIVE_TERMS = [
  '好看', '喜欢', '精彩', '期待', '加油', '感动', '爱了', '支持', '上头', '神作',
  '带感', '不错', '入迷', '停不下来', '打赏', '催更', '爽', '棒', '笑死', '有感觉',
]
const NEGATIVE_TERMS = [
  '追不下去', '看不下去', '弃书', '弃了', '难看', '水文', '注水', '拖沓', '离谱',
  '崩了', '无聊', '失望', '剧毒', '劝退', '垃圾', '逻辑不通', '降智', '圣母', '出戏', '尬',
]

export function scoreComment(content: string): number {
  const text = content || ''
  let pos = 0
  let neg = 0
  for (const term of POSITIVE_TERMS) if (text.includes(term)) pos++
  for (const term of NEGATIVE_TERMS) if (text.includes(term)) neg++
  if (pos === 0 && neg === 0) return 0
  return Math.round(((pos - neg) / (pos + neg)) * 100) / 100
}

export function summarizeSentiment(comments: { content: string }[]): SentimentSummary {
  let positive = 0
  let negative = 0
  let neutral = 0
  let total = 0
  const scored: { content: string; sentiment: number }[] = []
  for (const c of comments) {
    const score = scoreComment(c.content)
    total += score
    if (score > 0) positive++
    else if (score < 0) negative++
    else neutral++
    scored.push({ content: c.content, sentiment: score })
  }
  scored.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
  return {
    total: comments.length,
    positive,
    negative,
    neutral,
    average: comments.length ? Math.round((total / comments.length) * 100) / 100 : 0,
    samples: scored.slice(0, 5),
  }
}

export function compareHookChapters(rows: { completionRate: number; isHookChapter: boolean }[]): HookComparison {
  const valid = rows.filter((r) => r.completionRate > 0)
  const hook = valid.filter((r) => r.isHookChapter)
  const normal = valid.filter((r) => !r.isHookChapter)
  const avg = (list: typeof valid) => (list.length ? round(list.reduce((s, r) => s + r.completionRate, 0) / list.length, 2) : 0)
  const hookAvg = avg(hook)
  const normalAvg = avg(normal)
  const diff = round(hookAvg - normalAvg, 2)
  let note = '还没有足够的章节数据'
  if (hook.length === 0 && normal.length > 0) note = '已导入章节都没有标记钩子，暂无法对比'
  else if (hook.length > 0 && normal.length > 0) {
    if (diff >= 3) note = `挂了钩子的章读完率平均高 ${diff} 个点（相关观察，不代表因果）`
    else if (diff <= -3) note = `挂了钩子的章读完率平均低 ${Math.abs(diff)} 个点，检查钩子是否兑现（相关观察，不代表因果）`
    else note = '挂钩章与普通章读完率接近，钩子暂未体现差异'
  }
  return { hookCount: hook.length, normalCount: normal.length, hookAvg, normalAvg, note }
}

// ===== 脱敏导出 =====

export function bucketNumber(value: number): string {
  const n = Math.max(0, Number(value) || 0)
  if (n === 0) return '0'
  if (n < 100) return '1-99'
  if (n < 1000) return '100-999'
  if (n < 5000) return '1000-4999'
  if (n < 10000) return '5000-9999'
  return '1 万以上'
}

export function bucketRate(value: number): string {
  const n = Math.max(0, Math.min(100, Number(value) || 0))
  const lower = Math.floor(n / 10) * 10
  const upper = Math.min(100, lower + 10)
  return `${lower}-${upper}%`
}

export function bucketRevenue(value: number): string {
  const n = Math.max(0, Number(value) || 0)
  if (n === 0) return '无收益'
  if (n < 100) return '100 元以内'
  if (n < 1000) return '100-999 元'
  if (n < 5000) return '1000-4999 元'
  if (n < 10000) return '5000-9999 元'
  return '1 万元以上'
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 脱敏导出：不含平台名、章节名、评论原文与精确数值。 */
export function buildMaskedCsv(
  daily: { date: string; reads: number; completionRate: number; comments: number; revenue: number }[],
  chapters: { platformOrder: number; reads: number; completionRate: number; comments: number; revenue: number }[],
): string {
  const lines = ['类型,日期或序号,阅读区间,读完率区间,评论区间,收益区间']
  for (const d of [...daily].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push([
      '每日', d.date, bucketNumber(d.reads), bucketRate(d.completionRate),
      bucketNumber(d.comments), bucketRevenue(d.revenue),
    ].map(csvCell).join(','))
  }
  for (const c of [...chapters].sort((a, b) => a.platformOrder - b.platformOrder)) {
    lines.push([
      '章节', `第 ${c.platformOrder} 章`, bucketNumber(c.reads), bucketRate(c.completionRate),
      bucketNumber(c.comments), bucketRevenue(c.revenue),
    ].map(csvCell).join(','))
  }
  return lines.join('\n')
}

// 部分导出函数需要引用类型以保持 API 明确
export type PlatformExportInput = {
  daily: Parameters<typeof buildMaskedCsv>[0]
  chapters: Parameters<typeof buildMaskedCsv>[1]
  comments?: PlatformComment[]
}