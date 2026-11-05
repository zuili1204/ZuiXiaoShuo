import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  recordChapterSave, flushSession, flushAllSessions, appendAdjustment,
  recoverPendingSession, getDailyStats, setDailyWordGoal, computeBacklog,
  loadSessionRecords, toDateKey,
} from '../session-service'
import { chapterService } from '../data-service'

const NOVEL = 'nov-session'
const files = new Map<string, string>()
const settings = new Map<string, string>()
const chapters: any[] = []

function mockQuery(sql: string, params: any[] = []): any[] {
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
  if (sql.startsWith('SELECT * FROM chapters WHERE id')) {
    const row = chapters.find((c) => c.id === params[0])
    return row ? [row] : []
  }
  if (sql.startsWith('UPDATE chapters SET word_count')) {
    const row = chapters.find((c) => c.id === params[2])
    if (row) row.word_count = params[0]
    return []
  }
  if (sql.startsWith('SELECT novel_id FROM volumes')) {
    return [{ novel_id: NOVEL }]
  }
  return []
}

beforeEach(() => {
  files.clear()
  settings.clear()
  chapters.length = 0
  localStorage.clear()
  ;(globalThis as any).window = {
    electronAPI: {
      db: { query: mockQuery },
      file: {
        exists: async (p: string) => files.has(p),
        read: async (p: string) => files.get(p) ?? '',
        write: async (p: string, c: string) => { files.set(p, c) },
      },
    },
  }
})

afterEach(async () => {
  // 把残留内存会话落盘，避免影响后续用例
  await flushAllSessions()
  localStorage.clear()
})

const T0 = new Date(2026, 10, 3, 9, 0, 0).getTime() // 本地 2026-11-03 09:00
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

describe('日更会话：记录与合并', () => {
  it('同一窗口内的多次保存合并为一条净值记录', async () => {
    await recordChapterSave(NOVEL, 'c1', 0, 500, { now: T0 })
    await recordChapterSave(NOVEL, 'c1', 500, 300, { now: T0 + MIN })

    const pendingStats = await getDailyStats(NOVEL, { now: T0 + 2 * MIN })
    expect(pendingStats.todayWords).toBe(300)
    expect(pendingStats.pendingWords).toBe(300)

    await flushSession(NOVEL, T0 + 3 * MIN)
    const rows = await loadSessionRecords(NOVEL)
    expect(rows).toHaveLength(1)
    expect(rows[0].wordsAdded).toBe(300)
    expect(rows[0].source).toBe('manual')
    expect(rows[0].chapterId).toBe('c1')

    const stats = await getDailyStats(NOVEL, { now: T0 + 4 * MIN })
    expect(stats.todayWords).toBe(300)
    expect(stats.pendingWords).toBe(0)
  })

  it('超过 10 分钟窗口自动结束上一段会话', async () => {
    await recordChapterSave(NOVEL, 'c1', 0, 500, { now: T0 })
    await recordChapterSave(NOVEL, 'c1', 500, 600, { now: T0 + 11 * MIN })

    const rows = await loadSessionRecords(NOVEL)
    expect(rows).toHaveLength(1)
    expect(rows[0].wordsAdded).toBe(500)

    await flushSession(NOVEL, T0 + 12 * MIN)
    const all = await loadSessionRecords(NOVEL)
    expect(all).toHaveLength(2)
    expect(all[1].wordsAdded).toBe(100)
  })

  it('来源切换时先结束上一段会话', async () => {
    await recordChapterSave(NOVEL, 'c1', 0, 200, { now: T0 })
    await recordChapterSave(NOVEL, 'c1', 200, 900, { now: T0 + MIN, source: 'pipeline' })

    const rows = await loadSessionRecords(NOVEL)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('manual')
    expect(rows[0].wordsAdded).toBe(200)

    await flushSession(NOVEL, T0 + 2 * MIN)
    const all = await loadSessionRecords(NOVEL)
    expect(all[1].source).toBe('pipeline')
    expect(all[1].wordsAdded).toBe(700)
  })

  it('删减产生的负增量按净值记录', async () => {
    await recordChapterSave(NOVEL, 'c1', 500, 300, { now: T0 })
    await flushSession(NOVEL, T0 + MIN)
    const rows = await loadSessionRecords(NOVEL)
    expect(rows[0].wordsAdded).toBe(-200)
  })
})

describe('日更会话：按日聚合与连续天数', () => {
  it('跨天今日归零，近 7 天保留历史', async () => {
    const yesterday = T0 - DAY
    await recordChapterSave(NOVEL, 'c1', 0, 800, { now: yesterday })
    await flushSession(NOVEL, yesterday + MIN)

    const stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.today).toBe(toDateKey(T0))
    expect(stats.todayWords).toBe(0)
    const yKey = toDateKey(yesterday)
    expect(stats.week.find((d) => d.date === yKey)?.words).toBe(800)
    expect(stats.week).toHaveLength(7)
  })

  it('今日达标计入连续天数；今日未达标时从昨天续算', async () => {
    await setDailyWordGoal(NOVEL, 1000)

    await recordChapterSave(NOVEL, 'c1', 0, 1200, { now: T0 - 2 * DAY })
    await flushSession(NOVEL, T0 - 2 * DAY + MIN)
    await recordChapterSave(NOVEL, 'c1', 0, 1100, { now: T0 - DAY })
    await flushSession(NOVEL, T0 - DAY + MIN)

    let stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.streak).toBe(2)

    await recordChapterSave(NOVEL, 'c1', 0, 1000, { now: T0 })
    stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.todayWords).toBe(1000)
    expect(stats.streak).toBe(3)
  })

  it('目标可覆盖，默认 3000', async () => {
    let stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.goal).toBe(3000)
    await setDailyWordGoal(NOVEL, 2000)
    stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.goal).toBe(2000)
  })

  it('修正行按指定日期计入，且不占会话数', async () => {
    const today = toDateKey(T0)
    await appendAdjustment(NOVEL, 250, { date: today, now: T0 })
    const stats = await getDailyStats(NOVEL, { now: T0 })
    expect(stats.todayWords).toBe(250)
    expect(stats.week.find((d) => d.date === today)?.sessions).toBe(0)
  })
})

describe('日更会话：异常退出补记', () => {
  it('草稿补记为 recovered，同一会话不重复补记', async () => {
    const draft = {
      id: 's_crash',
      novelId: NOVEL,
      chapterId: 'c1',
      startedAt: T0,
      lastActivity: T0 + MIN,
      wordsAdded: 420,
      source: 'manual',
    }
    localStorage.setItem(`zxs:session-draft:${NOVEL}`, JSON.stringify(draft))
    localStorage.setItem('zxs:session-drafts', JSON.stringify([NOVEL]))

    const recovered = await recoverPendingSession(NOVEL, T0 + 2 * MIN)
    expect(recovered).toBe(true)

    const rows = await loadSessionRecords(NOVEL)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('recovered')
    expect(rows[0].wordsAdded).toBe(420)
    expect(localStorage.getItem(`zxs:session-draft:${NOVEL}`)).toBeNull()

    const again = await recoverPendingSession(NOVEL, T0 + 3 * MIN)
    expect(again).toBe(false)
    expect(await loadSessionRecords(NOVEL)).toHaveLength(1)
  })
})

describe('日更会话：保存链路与存稿', () => {
  it('章节保存带来源时自动计入今日字数', async () => {
    chapters.push({
      id: 'c1', volume_id: 'v1', title: '第一章', order_num: 1,
      content_path: 'content/c1.md', word_count: 2, status: 'draft',
      target_word_count: 3000, hooks: '[]', summary: '',
    })

    await chapterService.saveContent('c1', '一二三四五', { source: 'manual', novelId: NOVEL })

    const stats = await getDailyStats(NOVEL, { now: Date.now() })
    expect(stats.todayWords).toBe(3)
    expect(stats.pendingWords).toBe(3)
  })

  it('computeBacklog 只统计已发布之后的定稿章', () => {
    const list = [
      { status: 'final', wordCount: 100 },
      { status: 'final', wordCount: 200 },
      { status: 'draft', wordCount: 300 },
      { status: 'final', wordCount: 400 },
    ]
    expect(computeBacklog(list, 2)).toEqual({ chapters: 1, words: 400 })
    expect(computeBacklog(list, 0)).toEqual({ chapters: 3, words: 700 })
  })
})
