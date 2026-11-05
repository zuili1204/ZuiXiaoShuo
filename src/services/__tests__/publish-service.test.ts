import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  autoPlanStock,
  getPublishOverview,
  getReadyText,
  markPublished,
  savePublishPlan,
} from '../publish-service'

const novelId = 'n1'
const settings = new Map<string, string>()
let plans: any[] = []

const localRows = [
  { id: 'c1', title: '回到那一年', order_num: 1, word_count: 3000, status: 'final', hooks: '[]', volume_order: 1 },
  { id: 'c2', title: '雨夜来客', order_num: 2, word_count: 3200, status: 'final', hooks: '["门外"]', volume_order: 1 },
  { id: 'c3', title: '旧照片', order_num: 3, word_count: 2800, status: 'final', hooks: '[]', volume_order: 1 },
  { id: 'c4', title: '归途', order_num: 4, word_count: 3000, status: 'draft', hooks: '[]', volume_order: 1 },
]

beforeEach(() => {
  settings.clear()
  plans = []
  vi.clearAllMocks()
  ;(globalThis as any).window = {
    electronAPI: {
      db: {
        query: vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.includes('FROM chapters c JOIN volumes')) return localRows
          if (sql.startsWith('SELECT value FROM settings')) {
            const v = settings.get(params[0])
            return v == null ? [] : [{ value: v }]
          }
          if (sql.startsWith('SELECT key FROM settings')) {
            return settings.has(params[0]) ? [{ key: params[0] }] : []
          }
          if (sql.startsWith('UPDATE settings')) {
            settings.set(params[1], params[0])
            return []
          }
          if (sql.startsWith('INSERT INTO settings')) {
            settings.set(params[0], params[1])
            return []
          }
          if (sql.includes('FROM publish_plans') && sql.includes('chapter_id = ?')) {
            return plans.filter((p) => p.novel_id === params[0] && p.chapter_id === params[1])
          }
          if (sql.includes('FROM publish_plans')) {
            return plans.filter((p) => p.novel_id === params[0])
          }
          if (sql.startsWith('INSERT INTO publish_plans')) {
            const isSave = params.length === 8
            const row = {
              id: params[0],
              novel_id: params[1],
              chapter_id: params[2],
              planned_date: params[3],
              status: isSave ? params[4] : 'published',
              note: isSave ? params[5] : params[4],
              created_at: isSave ? params[6] : params[5],
              updated_at: isSave ? params[7] : params[6],
            }
            const idx = plans.findIndex((p) => p.novel_id === row.novel_id && p.chapter_id === row.chapter_id)
            if (idx >= 0) plans[idx] = { ...plans[idx], ...row, id: plans[idx].id, created_at: plans[idx].created_at }
            else plans.push(row)
            return []
          }
          if (sql.startsWith('SELECT * FROM chapters WHERE id')) {
            return localRows.filter((c) => c.id === params[0])
          }
          return []
        }),
      },
      file: {
        read: vi.fn(async () => '正文内容'),
      },
    },
  }
})

describe('存稿概览', () => {
  it('按已发布章计算存稿与接下来的章节', async () => {
    settings.set(`novel:${novelId}:publishedChapter`, '1')
    const overview = await getPublishOverview(novelId)
    expect(overview.publishedChapter).toBe(1)
    expect(overview.totalChapters).toBe(4)
    expect(overview.stock.map((c) => c.chapterId)).toEqual(['c2', 'c3'])
    expect(overview.backlogChapters).toBe(2)
    expect(overview.backlogWords).toBe(6000)
    expect(overview.upcoming.map((c) => c.chapterId)).toEqual(['c2', 'c3', 'c4'])
  })
})

describe('发布计划', () => {
  it('保存计划只写本地排期，不改变已发布章', async () => {
    const plan = await savePublishPlan(novelId, 'c2', '2026-11-05', '周末发')
    expect(plan.plannedDate).toBe('2026-11-05')
    expect(plan.status).toBe('planned')
    expect(settings.has(`novel:${novelId}:publishedChapter`)).toBe(false)
  })

  it('标记已发布只增不减，并记录计划状态', async () => {
    await savePublishPlan(novelId, 'c2', '2026-11-05')
    const published = await markPublished(novelId, 'c2')
    expect(published).toBe(2)
    expect(settings.get(`novel:${novelId}:publishedChapter`)).toBe('2')
    expect(plans.find((p) => p.chapter_id === 'c2')?.status).toBe('published')

    const again = await markPublished(novelId, 'c1')
    expect(again).toBe(2)
    expect(settings.get(`novel:${novelId}:publishedChapter`)).toBe('2')
  })

  it('一键排期按每天 N 章顺延，不重复已排期章节', async () => {
    settings.set(`novel:${novelId}:publishedChapter`, '1')
    await savePublishPlan(novelId, 'c2', '2026-11-01')
    const result = await autoPlanStock(novelId, '2026-11-05', 1)
    expect(result.planned).toBe(1)
    expect(result.lastDate).toBe('2026-11-05')
    expect(plans.find((p) => p.chapter_id === 'c3')?.planned_date).toBe('2026-11-05')
    expect(plans).toHaveLength(2)
  })
})

describe('可发布文本', () => {
  it('返回标题与正文，不触发任何发布动作', async () => {
    const ready = await getReadyText(novelId, 'c2')
    expect(ready.title).toBe('第2章 雨夜来客')
    expect(ready.content).toBe('正文内容')
    expect(settings.has(`novel:${novelId}:publishedChapter`)).toBe(false)
    expect(plans).toHaveLength(0)
  })
})