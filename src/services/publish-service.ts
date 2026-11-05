// P4：存稿与发布计划。只生成计划与可复制文本，绝不自动发布。
import type { PublishChapter, PublishOverview, PublishPlan, PublishPlanStatus } from '@shared/platform-types'
import { normalizeDate } from '@shared/platform-metrics'
import { listLocalChapters } from './platform-service'
import { chapterService } from './data-service'
import { getPublishedChapter, setPublishedChapter } from './session-service'

const api = () => window.electronAPI

const uid = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function rowToPlan(row: any): PublishPlan {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    plannedDate: row.planned_date,
    status: (row.status || 'planned') as PublishPlanStatus,
    note: row.note ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listPublishPlans(novelId: string): Promise<PublishPlan[]> {
  const rows = (await api().db.query(
    'SELECT * FROM publish_plans WHERE novel_id = ? ORDER BY planned_date ASC',
    [novelId],
  )) as any[]
  return rows.map(rowToPlan)
}

export async function getPublishOverview(novelId: string): Promise<PublishOverview> {
  const [chapters, publishedChapter, plans] = await Promise.all([
    listLocalChapters(novelId),
    getPublishedChapter(novelId),
    listPublishPlans(novelId),
  ])
  const stock: PublishChapter[] = chapters.filter((c) => c.status === 'final' && c.order > publishedChapter)
  const upcoming = chapters.filter((c) => c.order > publishedChapter).slice(0, 10)
  return {
    publishedChapter,
    totalChapters: chapters.length,
    backlogChapters: stock.length,
    backlogWords: stock.reduce((sum, c) => sum + c.wordCount, 0),
    stock,
    upcoming,
    plans,
  }
}

export async function savePublishPlan(
  novelId: string,
  chapterId: string,
  plannedDate: string,
  note = '',
): Promise<PublishPlan> {
  const date = normalizeDate(plannedDate)
  if (!date) throw new Error('计划日期格式无法识别')
  const existing = (await api().db.query(
    'SELECT * FROM publish_plans WHERE novel_id = ? AND chapter_id = ?',
    [novelId, chapterId],
  )) as any[]
  const now = new Date().toISOString()
  const status: PublishPlanStatus = existing[0]?.status === 'published' ? 'published' : 'planned'
  await api().db.query(
    `INSERT INTO publish_plans
      (id, novel_id, chapter_id, planned_date, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(novel_id, chapter_id) DO UPDATE SET
       planned_date = excluded.planned_date,
       status = excluded.status,
       note = excluded.note,
       updated_at = excluded.updated_at`,
    [existing[0]?.id ?? uid('plan'), novelId, chapterId, date, status, note, existing[0]?.created_at ?? now, now],
  )
  const rows = (await api().db.query(
    'SELECT * FROM publish_plans WHERE novel_id = ? AND chapter_id = ?',
    [novelId, chapterId],
  )) as any[]
  return rowToPlan(rows[0])
}

export async function removePublishPlan(planId: string): Promise<void> {
  await api().db.query('DELETE FROM publish_plans WHERE id = ?', [planId])
}

export async function listPlansForNovel(novelId: string): Promise<PublishPlan[]> {
  return listPublishPlans(novelId)
}

async function chapterGlobalOrder(novelId: string, chapterId: string): Promise<number | null> {
  const chapters = await listLocalChapters(novelId)
  return chapters.find((c) => c.chapterId === chapterId)?.order ?? null
}

/**
 * 手工确认「已发布」：更新已发布章序号（只增不减）并记录计划状态。
 * 不触发任何平台操作。
 */
export async function markPublished(novelId: string, chapterId: string): Promise<number> {
  const order = await chapterGlobalOrder(novelId, chapterId)
  if (!order) throw new Error('章节不存在或不属于本书')
  const current = await getPublishedChapter(novelId)
  const next = Math.max(current, order)
  await setPublishedChapter(novelId, next)

  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const existing = (await api().db.query(
    'SELECT * FROM publish_plans WHERE novel_id = ? AND chapter_id = ?',
    [novelId, chapterId],
  )) as any[]
  const now = new Date().toISOString()
  await api().db.query(
    `INSERT INTO publish_plans
      (id, novel_id, chapter_id, planned_date, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'published', ?, ?, ?)
     ON CONFLICT(novel_id, chapter_id) DO UPDATE SET
       status = 'published',
       updated_at = excluded.updated_at`,
    [existing[0]?.id ?? uid('plan'), novelId, chapterId, date, existing[0]?.note ?? '', existing[0]?.created_at ?? now, now],
  )
  return next
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 给未排期的存稿按「每天 N 章」生成计划；只写计划，不发布。 */
export async function autoPlanStock(
  novelId: string,
  startDate: string,
  perDay = 1,
): Promise<{ planned: number; lastDate: string | null }> {
  const start = normalizeDate(startDate)
  if (!start) throw new Error('开始日期格式无法识别')
  const overview = await getPublishOverview(novelId)
  const planned = new Set(overview.plans.map((p) => p.chapterId))
  const pending = overview.stock.filter((c) => !planned.has(c.chapterId))
  if (pending.length === 0) return { planned: 0, lastDate: null }

  const startAt = new Date(`${start}T00:00:00`)
  const step = Math.max(1, Math.floor(perDay || 1))
  let lastDate: string | null = null
  for (let i = 0; i < pending.length; i++) {
    const date = toDateKey(addDays(startAt, Math.floor(i / step)))
    await savePublishPlan(novelId, pending[i].chapterId, date)
    lastDate = date
  }
  return { planned: pending.length, lastDate }
}

/** 生成可直接粘贴到平台的正文（标题 + 正文），不在任何平台执行发布。 */
export async function getReadyText(novelId: string, chapterId: string): Promise<{ title: string; content: string }> {
  const chapters = await listLocalChapters(novelId)
  const local = chapters.find((c) => c.chapterId === chapterId)
  const content = await chapterService.loadContent(chapterId)
  return {
    title: local ? `第${local.order}章 ${local.title}` : '',
    content: content || '',
  }
}