// P4：系列书分组与多书概览（不改变现有单书数据结构）
import type { SeriesBook, SeriesGroup } from '@shared/platform-types'

const api = () => window.electronAPI

interface BookRow {
  id: string
  title: string
  series_name: string | null
  series_order: number | null
  updated_at: string
  chapter_count: number
  word_count: number
}

async function loadBooks(): Promise<SeriesBook[]> {
  const rows = (await api().db.query(
    `SELECT n.id, n.title, n.series_name, n.series_order, n.updated_at,
       COUNT(c.id) AS chapter_count,
       COALESCE(SUM(c.word_count), 0) AS word_count
     FROM novels n
     LEFT JOIN volumes v ON v.novel_id = n.id
     LEFT JOIN chapters c ON c.volume_id = v.id
     GROUP BY n.id
     ORDER BY n.updated_at DESC`,
  )) as BookRow[]
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    seriesName: row.series_name ?? '',
    seriesOrder: Number(row.series_order) || 0,
    chapterCount: Number(row.chapter_count) || 0,
    wordCount: Number(row.word_count) || 0,
    updatedAt: row.updated_at,
  }))
}

export async function listSeriesForNovel(novelId: string): Promise<SeriesGroup | null> {
  const books = await loadBooks()
  const current = books.find((b) => b.id === novelId)
  if (!current || !current.seriesName.trim()) return null
  const members = books
    .filter((b) => b.seriesName === current.seriesName)
    .sort((a, b) => (a.seriesOrder || 9999) - (b.seriesOrder || 9999) || a.title.localeCompare(b.title))
  return {
    name: current.seriesName,
    books: members,
    chapterCount: members.reduce((sum, b) => sum + b.chapterCount, 0),
    wordCount: members.reduce((sum, b) => sum + b.wordCount, 0),
  }
}

export async function listAllBooks(): Promise<SeriesBook[]> {
  return loadBooks()
}

export async function setNovelSeries(novelId: string, seriesName: string, seriesOrder = 0): Promise<void> {
  await api().db.query(
    'UPDATE novels SET series_name = ?, series_order = ?, updated_at = ? WHERE id = ?',
    [(seriesName || '').trim(), Math.max(0, Math.floor(Number(seriesOrder) || 0)), new Date().toISOString(), novelId],
  )
}

/** 同系列写下一本时可复用的设定摘要（只读，不改任何书）。 */
export async function getSeriesContext(novelId: string): Promise<{ name: string; bookTitles: string[] } | null> {
  const series = await listSeriesForNovel(novelId)
  if (!series) return null
  return { name: series.name, bookTitles: series.books.map((b) => b.title) }
}