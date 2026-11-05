// P4：平台数据手工导入与本地分析（不做账号托管、不做爬取）
import type {
  ChapterMapping,
  ChapterMetric,
  ChapterMetricInput,
  DailyMetric,
  DailyMetricInput,
  ImportResult,
  PlatformAnalysis,
  PlatformComment,
  PublishChapter,
  UnmappedChapter,
} from '@shared/platform-types'
import {
  buildMaskedCsv,
  buildTrend,
  compareHookChapters,
  findCompletionDrops,
  normalizeDate,
  parseChapterCsv,
  parseCommentsCsv,
  parseDailyCsv,
  scoreComment,
  summarizeSentiment,
} from '@shared/platform-metrics'

const api = () => window.electronAPI

const uid = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const nowIso = () => new Date().toISOString()

interface DbQuery {
  sql: string
  params: unknown[]
}

/** 批量导入走单事务，避免逐行往返与中途失败留下半份数据。 */
async function runBatch(queries: DbQuery[]): Promise<void> {
  if (!queries.length) return
  await api().db.transaction(queries)
}

export interface LocalChapterRef extends PublishChapter {
  volumeOrder: number
}

/** 按「卷序 + 卷内章序」拍平全书章节，全局序号从 1 开始。 */
export async function listLocalChapters(novelId: string): Promise<LocalChapterRef[]> {
  const rows = (await api().db.query(
    `SELECT c.id, c.title, c.order_num, c.word_count, c.status, c.hooks, v.order_num AS volume_order
     FROM chapters c JOIN volumes v ON v.id = c.volume_id
     WHERE v.novel_id = ?
     ORDER BY v.order_num ASC, c.order_num ASC`,
    [novelId],
  )) as any[]
  return rows.map((row, idx) => ({
    chapterId: row.id,
    title: row.title,
    order: idx + 1,
    wordCount: Number(row.word_count) || 0,
    status: row.status,
    hooks: parseHooks(row.hooks),
    volumeOrder: Number(row.volume_order) || 0,
  }))
}

function parseHooks(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function normalizeChapterName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/第[0-9一二三四五六七八九十百千零两]+[章节回话]/g, '')
    .replace(/[《》「」【】\[\]（）()\s:：·、,.，。!！?？\-—_]/g, '')
}

/** 章节名/序号 → 本地章节：先精确标题匹配，再按全局序号匹配。 */
export function matchLocalChapter(
  platformChapterName: string,
  platformOrder: number,
  chapters: LocalChapterRef[],
): LocalChapterRef | null {
  const target = normalizeChapterName(platformChapterName)
  if (target) {
    const exact = chapters.filter((c) => normalizeChapterName(c.title) === target)
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) {
      const sameOrder = exact.find((c) => c.order === platformOrder)
      if (sameOrder) return sameOrder
    }
  }
  if (platformOrder > 0) {
    return chapters.find((c) => c.order === platformOrder) ?? null
  }
  return null
}

function rowToDaily(row: any): DailyMetric {
  return {
    id: row.id,
    novelId: row.novel_id,
    platform: row.platform,
    date: row.date,
    reads: Number(row.reads) || 0,
    completionRate: Number(row.completion_rate) || 0,
    comments: Number(row.comments) || 0,
    revenue: Number(row.revenue) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToChapterMetric(row: any): ChapterMetric {
  return {
    id: row.id,
    novelId: row.novel_id,
    platform: row.platform,
    date: row.date ?? '',
    chapterId: row.chapter_id ?? null,
    platformChapterName: row.platform_chapter_name,
    platformOrder: Number(row.platform_order) || 0,
    reads: Number(row.reads) || 0,
    completionRate: Number(row.completion_rate) || 0,
    comments: Number(row.comments) || 0,
    revenue: Number(row.revenue) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToComment(row: any): PlatformComment {
  return {
    id: row.id,
    novelId: row.novel_id,
    platform: row.platform,
    date: row.date ?? '',
    chapterId: row.chapter_id ?? null,
    platformChapterName: row.platform_chapter_name ?? '',
    content: row.content,
    sentiment: Number(row.sentiment) || 0,
    createdAt: row.created_at,
  }
}

// ===== 每日数据 =====

export async function listDailyMetrics(novelId: string, platform: string, limit = 90): Promise<DailyMetric[]> {
  const rows = (await api().db.query(
    'SELECT * FROM platform_daily_metrics WHERE novel_id = ? AND platform = ? ORDER BY date DESC LIMIT ?',
    [novelId, platform, limit],
  )) as any[]
  return rows.map(rowToDaily).sort((a, b) => a.date.localeCompare(b.date))
}

function dailyUpsertQuery(
  novelId: string,
  platform: string,
  input: DailyMetricInput & { date: string },
): DbQuery {
  const now = nowIso()
  return {
    sql: `INSERT INTO platform_daily_metrics
      (id, novel_id, platform, date, reads, completion_rate, comments, revenue, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(novel_id, platform, date) DO UPDATE SET
       reads = excluded.reads,
       completion_rate = excluded.completion_rate,
       comments = excluded.comments,
       revenue = excluded.revenue,
       updated_at = excluded.updated_at`,
    params: [
      uid('pdm'), novelId, platform, input.date,
      Math.max(0, Math.round(input.reads || 0)),
      Math.max(0, Math.min(100, Number(input.completionRate) || 0)),
      Math.max(0, Math.round(input.comments || 0)),
      Math.max(0, Number(input.revenue) || 0),
      now, now,
    ],
  }
}

export async function saveDailyMetric(
  novelId: string,
  platform: string,
  input: DailyMetricInput,
): Promise<DailyMetric> {
  const date = normalizeDate(input.date)
  if (!date) throw new Error('日期格式无法识别')
  const query = dailyUpsertQuery(novelId, platform, { ...input, date })
  await api().db.query(query.sql, query.params)
  const rows = (await api().db.query(
    'SELECT * FROM platform_daily_metrics WHERE novel_id = ? AND platform = ? AND date = ?',
    [novelId, platform, date],
  )) as any[]
  return rowToDaily(rows[0])
}

export async function importDailyCsv(novelId: string, platform: string, text: string): Promise<ImportResult> {
  const parsed = parseDailyCsv(text)
  if (parsed.rows.length === 0) {
    return { imported: 0, updated: 0, errors: parsed.errors, unmapped: [] }
  }
  const existing = new Set(
    (await listDailyMetrics(novelId, platform, 3650)).map((r) => r.date),
  )
  let imported = 0
  let updated = 0
  const queries: DbQuery[] = []
  for (const row of parsed.rows) {
    queries.push(dailyUpsertQuery(novelId, platform, row))
    if (existing.has(row.date)) updated++
    else {
      imported++
      existing.add(row.date)
    }
  }
  await runBatch(queries)
  return { imported, updated, errors: parsed.errors, unmapped: [] }
}

// ===== 章节数据 =====

/** 不传 limit 时读取全部章节数据，避免长书被固定条数截断。 */
export async function listChapterMetrics(novelId: string, platform: string, limit?: number): Promise<ChapterMetric[]> {
  const rows = (await api().db.query(
    `SELECT * FROM platform_chapter_metrics
     WHERE novel_id = ? AND platform = ?
     ORDER BY platform_order ASC, date ASC${limit == null ? '' : ' LIMIT ?'}`,
    limit == null ? [novelId, platform] : [novelId, platform, limit],
  )) as any[]
  return rows.map(rowToChapterMetric)
}

export async function listMappings(novelId: string, platform: string): Promise<ChapterMapping[]> {
  const rows = (await api().db.query(
    'SELECT * FROM platform_chapter_mappings WHERE novel_id = ? AND platform = ?',
    [novelId, platform],
  )) as any[]
  return rows.map((row) => ({
    novelId: row.novel_id,
    platform: row.platform,
    platformChapterName: row.platform_chapter_name,
    platformOrder: Number(row.platform_order) || 0,
    chapterId: row.chapter_id,
    updatedAt: row.updated_at,
  }))
}

function chapterBindingQueries(
  novelId: string,
  platform: string,
  platformChapterName: string,
  platformOrder: number,
  chapterId: string,
): DbQuery[] {
  const now = nowIso()
  return [
    {
      sql: `INSERT INTO platform_chapter_mappings
        (novel_id, platform, platform_chapter_name, platform_order, chapter_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, platform, platform_chapter_name) DO UPDATE SET
         platform_order = excluded.platform_order,
         chapter_id = excluded.chapter_id,
         updated_at = excluded.updated_at`,
      params: [novelId, platform, platformChapterName, platformOrder, chapterId, now],
    },
    {
      sql: `UPDATE platform_chapter_metrics SET chapter_id = ?
       WHERE novel_id = ? AND platform = ? AND platform_chapter_name = ?`,
      params: [chapterId, novelId, platform, platformChapterName],
    },
  ]
}

export async function bindChapter(
  novelId: string,
  platform: string,
  platformChapterName: string,
  platformOrder: number,
  chapterId: string,
): Promise<void> {
  await runBatch(chapterBindingQueries(novelId, platform, platformChapterName, platformOrder, chapterId))
}

function chapterMetricUpsertQuery(
  novelId: string,
  platform: string,
  row: ChapterMetricInput,
  chapterId: string | null,
): DbQuery {
  const now = nowIso()
  return {
    sql: `INSERT INTO platform_chapter_metrics
      (id, novel_id, platform, date, chapter_id, platform_chapter_name, platform_order,
       reads, completion_rate, comments, revenue, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(novel_id, platform, date, platform_chapter_name) DO UPDATE SET
       chapter_id = excluded.chapter_id,
       platform_order = excluded.platform_order,
       reads = excluded.reads,
       completion_rate = excluded.completion_rate,
       comments = excluded.comments,
       revenue = excluded.revenue,
       updated_at = excluded.updated_at`,
    params: [
      uid('pcm'), novelId, platform, row.date ?? '', chapterId, row.platformChapterName,
      row.platformOrder ?? 0,
      Math.max(0, Math.round(row.reads || 0)),
      Math.max(0, Math.min(100, Number(row.completionRate) || 0)),
      Math.max(0, Math.round(row.comments || 0)),
      Math.max(0, Number(row.revenue) || 0),
      now, now,
    ],
  }
}

export async function importChapterCsv(novelId: string, platform: string, text: string): Promise<ImportResult> {
  const parsed = parseChapterCsv(text)
  const errors = [...parsed.errors]
  if (parsed.rows.length === 0) return { imported: 0, updated: 0, errors, unmapped: [] }

  const chapters = await listLocalChapters(novelId)
  const mappings = await listMappings(novelId, platform)
  const mappedByName = new Map(mappings.map((m) => [m.platformChapterName, m.chapterId]))
  const existing = new Set(
    (await listChapterMetrics(novelId, platform)).map((r) => `${r.date}|${r.platformChapterName}`),
  )

  let imported = 0
  let updated = 0
  const unmapped: UnmappedChapter[] = []
  const unmappedSeen = new Set<string>()
  const queries: DbQuery[] = []

  for (const row of parsed.rows) {
    const order = row.platformOrder ?? 0
    const storedId = mappedByName.get(row.platformChapterName)
    const local = (storedId ? chapters.find((c) => c.chapterId === storedId) : null)
      ?? matchLocalChapter(row.platformChapterName, order, chapters)
    // 映射指向已删除章节时不再写入失效 id，分析阶段按章名回退匹配
    const resolved = local?.chapterId ?? null

    if (local) {
      queries.push(...chapterBindingQueries(novelId, platform, row.platformChapterName, order, local.chapterId))
      mappedByName.set(row.platformChapterName, local.chapterId)
    } else if (!unmappedSeen.has(row.platformChapterName)) {
      unmappedSeen.add(row.platformChapterName)
      unmapped.push({ platformChapterName: row.platformChapterName, platformOrder: order })
    }

    queries.push(chapterMetricUpsertQuery(novelId, platform, row, resolved))
    const key = `${row.date ?? ''}|${row.platformChapterName}`
    if (existing.has(key)) updated++
    else {
      imported++
      existing.add(key)
    }
  }
  await runBatch(queries)

  return { imported, updated, errors, unmapped }
}

// ===== 评论 =====

/** 不传 limit 时读取全部评论，长书导入去重不会被固定条数截断。 */
export async function listComments(novelId: string, platform: string, limit?: number): Promise<PlatformComment[]> {
  const rows = (await api().db.query(
    `SELECT * FROM platform_comments WHERE novel_id = ? AND platform = ? ORDER BY date DESC${
      limit == null ? '' : ' LIMIT ?'
    }`,
    limit == null ? [novelId, platform] : [novelId, platform, limit],
  )) as any[]
  return rows.map(rowToComment)
}

export async function importCommentsCsv(novelId: string, platform: string, text: string): Promise<ImportResult> {
  const parsed = parseCommentsCsv(text)
  const errors = [...parsed.errors]
  if (parsed.rows.length === 0) return { imported: 0, updated: 0, errors, unmapped: [] }

  const chapters = await listLocalChapters(novelId)
  const mappings = await listMappings(novelId, platform)
  const mappedByName = new Map(mappings.map((m) => [m.platformChapterName, m.chapterId]))
  const existing = new Set(
    (await listComments(novelId, platform)).map((c) => `${c.date}|${c.platformChapterName}|${c.content}`),
  )

  let imported = 0
  let updated = 0
  const queries: DbQuery[] = []
  for (const row of parsed.rows) {
    const local = (mappedByName.get(row.platformChapterName)
      ? chapters.find((c) => c.chapterId === mappedByName.get(row.platformChapterName))
      : null) ?? matchLocalChapter(row.platformChapterName, 0, chapters)
    const key = `${row.date}|${row.platformChapterName}|${row.content}`
    if (existing.has(key)) { updated++; continue }
    queries.push({
      sql: `INSERT INTO platform_comments
        (id, novel_id, platform, date, chapter_id, platform_chapter_name, content, sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        uid('pc'), novelId, platform, row.date, local?.chapterId ?? null,
        row.platformChapterName, row.content, scoreComment(row.content), nowIso(),
      ],
    })
    existing.add(key)
    imported++
  }
  await runBatch(queries)
  return { imported, updated, errors, unmapped: [] }
}

// ===== 分析 =====

/** 同一平台章名多次导入时只取最新一条（按日期 + 创建时间）。 */
function latestPerChapter(rows: ChapterMetric[]): ChapterMetric[] {
  const map = new Map<string, ChapterMetric>()
  for (const row of rows) {
    const prev = map.get(row.platformChapterName)
    if (!prev || row.date >= prev.date) map.set(row.platformChapterName, row)
  }
  return [...map.values()].sort((a, b) => a.platformOrder - b.platformOrder)
}

export async function analyzePlatform(
  novelId: string,
  platform: string,
  opts: { days?: number } = {},
): Promise<PlatformAnalysis> {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? 7)))
  const [daily, chapterRows, comments, mappings, chapters] = await Promise.all([
    listDailyMetrics(novelId, platform, 3650),
    listChapterMetrics(novelId, platform),
    listComments(novelId, platform),
    listMappings(novelId, platform),
    listLocalChapters(novelId),
  ])

  const dailyPoints = daily
    .slice(-days)
    .map((d) => ({
      date: d.date,
      reads: d.reads,
      completionRate: d.completionRate,
      comments: d.comments,
      revenue: d.revenue,
    }))

  const mappedById = new Map(chapters.map((c) => [c.chapterId, c]))
  const mappedByName = new Map(mappings.map((m) => [m.platformChapterName, m.chapterId]))
  const latest = latestPerChapter(chapterRows)
  const unmapped: UnmappedChapter[] = []

  const anomalyInputs = latest.map((row) => {
    // chapter_id 可能指向已删除章节，失效时继续按映射/章名回退
    const local =
      (row.chapterId ? mappedById.get(row.chapterId) : null)
      ?? mappedById.get(mappedByName.get(row.platformChapterName) ?? '')
      ?? matchLocalChapter(row.platformChapterName, row.platformOrder, chapters)
    if (!local) unmapped.push({ platformChapterName: row.platformChapterName, platformOrder: row.platformOrder })
    return {
      chapterId: local?.chapterId ?? null,
      chapterTitle: local?.title ?? row.platformChapterName,
      platformChapterName: row.platformChapterName,
      platformOrder: row.platformOrder,
      reads: row.reads,
      completionRate: row.completionRate,
      isHookChapter: (local?.hooks.length ?? 0) > 0,
      wordCount: local?.wordCount ?? 0,
    }
  })

  return {
    platform,
    days,
    trend: buildTrend(dailyPoints),
    anomalies: findCompletionDrops(anomalyInputs),
    sentiment: summarizeSentiment(comments),
    hookComparison: compareHookChapters(anomalyInputs),
    unmapped,
    dailyCount: daily.length,
    chapterCount: latest.length,
    commentCount: comments.length,
  }
}

export async function listPlatforms(novelId: string): Promise<string[]> {
  const rows = (await api().db.query(
    `SELECT platform FROM platform_daily_metrics WHERE novel_id = ?
     UNION SELECT platform FROM platform_chapter_metrics WHERE novel_id = ?
     UNION SELECT platform FROM platform_comments WHERE novel_id = ?`,
    [novelId, novelId, novelId],
  )) as { platform: string }[]
  return rows.map((r) => r.platform).filter(Boolean)
}

/** 脱敏导出：只保留日期/序号与区间，不含平台名、章节名、评论原文与精确数值。 */
export async function buildPlatformExport(novelId: string, platform: string): Promise<string> {
  const [daily, chapters] = await Promise.all([
    listDailyMetrics(novelId, platform, 3650),
    latestPerChapter(await listChapterMetrics(novelId, platform)),
  ])
  return buildMaskedCsv(daily, chapters)
}

export async function clearPlatformData(novelId: string, platform: string): Promise<void> {
  await api().db.query(
    'DELETE FROM platform_daily_metrics WHERE novel_id = ? AND platform = ?',
    [novelId, platform],
  )
  await api().db.query(
    'DELETE FROM platform_chapter_metrics WHERE novel_id = ? AND platform = ?',
    [novelId, platform],
  )
  await api().db.query(
    'DELETE FROM platform_comments WHERE novel_id = ? AND platform = ?',
    [novelId, platform],
  )
  await api().db.query(
    'DELETE FROM platform_chapter_mappings WHERE novel_id = ? AND platform = ?',
    [novelId, platform],
  )
}

export function chapterMetricInputDefaults(): ChapterMetricInput {
  return {
    date: '',
    platformChapterName: '',
    platformOrder: 0,
    reads: 0,
    completionRate: 0,
    comments: 0,
    revenue: 0,
  }
}