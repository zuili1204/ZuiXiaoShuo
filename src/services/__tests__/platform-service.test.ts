import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  analyzePlatform,
  bindChapter,
  buildPlatformExport,
  importChapterCsv,
  matchLocalChapter,
  normalizeChapterName,
  type LocalChapterRef,
} from '../platform-service'

const novelId = 'n1'
const platform = '测试平台'

const localRows = [
  { id: 'c1', title: '回到那一年', order_num: 1, word_count: 3000, status: 'final', hooks: '["门外的声音"]', volume_order: 1 },
  { id: 'c2', title: '雨夜来客', order_num: 2, word_count: 3200, status: 'final', hooks: '[]', volume_order: 1 },
  { id: 'c3', title: '旧照片', order_num: 3, word_count: 2800, status: 'final', hooks: '[]', volume_order: 1 },
  { id: 'c4', title: '归途', order_num: 4, word_count: 3000, status: 'draft', hooks: '[]', volume_order: 1 },
]

const latestLocal: LocalChapterRef[] = localRows.map((row, idx) => ({
  chapterId: row.id,
  title: row.title,
  order: idx + 1,
  wordCount: row.word_count,
  status: row.status,
  hooks: JSON.parse(row.hooks),
  volumeOrder: row.volume_order,
}))

let dailyRows: any[] = []
let chapterRows: any[] = []
let commentRows: any[] = []
let mappingRows: any[] = []

beforeEach(() => {
  vi.clearAllMocks()
  dailyRows = []
  chapterRows = []
  commentRows = []
  mappingRows = []
  ;(globalThis as any).window = {
    electronAPI: {
      db: {
        query: vi.fn(async (sql: string, params: any[] = []) => {
          if (sql.includes('FROM chapters c JOIN volumes')) return localRows
          if (sql.startsWith('INSERT INTO platform_daily_metrics')) {
            const date = params[3]
            const data = {
              id: params[0], novel_id: params[1], platform: params[2], date,
              reads: params[4], completion_rate: params[5], comments: params[6], revenue: params[7],
              created_at: params[8], updated_at: params[9],
            }
            const idx = dailyRows.findIndex((r) => r.date === date)
            if (idx >= 0) dailyRows[idx] = data
            else dailyRows.push(data)
            return []
          }
          if (sql.includes('FROM platform_daily_metrics')) return dailyRows
          if (sql.includes('FROM platform_chapter_mappings')) return mappingRows
          if (sql.startsWith('INSERT INTO platform_chapter_mappings')) {
            const row = {
              novel_id: params[0], platform: params[1], platform_chapter_name: params[2],
              platform_order: params[3], chapter_id: params[4], updated_at: params[5],
            }
            const idx = mappingRows.findIndex((r) => r.platform_chapter_name === row.platform_chapter_name)
            if (idx >= 0) mappingRows[idx] = row
            else mappingRows.push(row)
            return []
          }
          if (sql.startsWith('UPDATE platform_chapter_metrics')) return []
          if (sql.startsWith('INSERT INTO platform_chapter_metrics')) {
            chapterRows.push({
              id: params[0], novel_id: params[1], platform: params[2], date: params[3],
              chapter_id: params[4], platform_chapter_name: params[5], platform_order: params[6],
              reads: params[7], completion_rate: params[8], comments: params[9], revenue: params[10],
              created_at: params[11], updated_at: params[12],
            })
            return []
          }
          if (sql.includes('FROM platform_chapter_metrics')) return chapterRows
          if (sql.includes('FROM platform_comments')) return commentRows
          return []
        }),
        transaction: async (queries: { sql: string; params?: any[] }[]) => {
          const out: unknown[] = []
          for (const q of queries) {
            out.push(await (globalThis as any).window.electronAPI.db.query(q.sql, q.params))
          }
          return out
        },
      },
    },
  }
})

describe('章节名匹配', () => {
  it('去掉第 X 章前缀与标点后精确匹配', () => {
    expect(normalizeChapterName('第1章 回到那一年')).toBe('回到那一年')
    expect(matchLocalChapter('第1章 回到那一年', 1, latestLocal)?.chapterId).toBe('c1')
  })

  it('标题对不上时按全局序号回退', () => {
    expect(matchLocalChapter('平台自定义标题', 2, latestLocal)?.chapterId).toBe('c2')
    expect(matchLocalChapter('平台自定义标题', 99, latestLocal)).toBeNull()
  })
})

describe('导入', () => {
  it('章节数据自动对应本地章节，未对应项单独列出', async () => {
    const result = await importChapterCsv(
      novelId,
      platform,
      '章节,章节序号,阅读,读完率,评论,收益\n第1章 回到那一年,1,18000,72%,120,52\n神秘章节,9,5000,40%,10,2',
    )
    expect(result.imported).toBe(2)
    expect(result.errors).toHaveLength(0)
    expect(result.unmapped).toEqual([{ platformChapterName: '神秘章节', platformOrder: 9 }])
    expect(mappingRows).toHaveLength(1)
    expect(mappingRows[0].chapter_id).toBe('c1')
    expect(chapterRows[0].chapter_id).toBe('c1')
    expect(chapterRows[1].chapter_id).toBeNull()
  })

  it('手工对应后，同名章节不会再提示未对应', async () => {
    await bindChapter(novelId, platform, '神秘章节', 9, 'c4')
    expect(mappingRows[0].chapter_id).toBe('c4')
  })

  it('同一份 CSV 内重复行只算一次新增，其余计为更新', async () => {
    const csv = '章节,章节序号,阅读,读完率,评论,收益\n第1章 回到那一年,1,100,70%,1,0\n第1章 回到那一年,1,120,71%,2,0'
    const result = await importChapterCsv(novelId, platform, csv)
    expect(result.imported).toBe(1)
    expect(result.updated).toBe(1)
    expect(chapterRows).toHaveLength(2)
  })
})

describe('分析', () => {
  beforeEach(() => {
    dailyRows = [
      ['2026-11-01', 2000, 70, 30, 10],
      ['2026-11-02', 1900, 69, 28, 9],
      ['2026-11-03', 1800, 68, 26, 9],
      ['2026-11-04', 1200, 64, 20, 7],
      ['2026-11-05', 1100, 63, 18, 6],
      ['2026-11-06', 1000, 62, 16, 6],
      ['2026-11-07', 900, 61, 14, 5],
    ].map(([date, reads, completion_rate, comments, revenue], i) => ({
      id: `d${i}`, novel_id: novelId, platform, date: String(date), reads,
      completion_rate, comments, revenue, created_at: '', updated_at: '',
    }))
    chapterRows = [
      ['c1', '第1章 回到那一年', 1, 72],
      ['c2', '第2章 雨夜来客', 2, 50],
      ['c3', '第3章 旧照片', 3, 70],
      ['c4', '第4章 归途', 4, 68],
      [null, '神秘章节', 9, 65],
    ].map(([chapter_id, name, order, rate], i) => ({
      id: `cm${i}`, novel_id: novelId, platform, date: '2026-11-07',
      chapter_id, platform_chapter_name: name, platform_order: order,
      reads: 10000 - i * 500, completion_rate: rate, comments: 10, revenue: 5,
      created_at: '', updated_at: '',
    }))
    commentRows = [
      { id: 'p1', novel_id: novelId, platform, date: '2026-11-07', chapter_id: 'c1', platform_chapter_name: '第一章', content: '太好看了，追了', sentiment: 1, created_at: '' },
      { id: 'p2', novel_id: novelId, platform, date: '2026-11-07', chapter_id: 'c2', platform_chapter_name: '第二章', content: '这章有点水，追不下去', sentiment: -1, created_at: '' },
    ]
  })

  it('7 天数据给出趋势、骤降章、情绪与钩子对比', async () => {
    const result = await analyzePlatform(novelId, platform, { days: 7 })
    expect(result.dailyCount).toBe(7)
    expect(result.trend.direction).toBe('down')
    expect(result.trend.points).toHaveLength(7)

    expect(result.anomalies.map((a) => a.chapterId)).toContain('c2')
    expect(result.anomalies[0].possibleCauses.length).toBeGreaterThan(0)

    expect(result.sentiment.positive).toBe(1)
    expect(result.sentiment.negative).toBe(1)
    expect(result.hookComparison.hookCount).toBe(1)
    expect(result.hookComparison.normalCount).toBe(4)

    expect(result.unmapped).toEqual([{ platformChapterName: '神秘章节', platformOrder: 9 }])
  })

  it('脱敏导出不含平台名、章节名与精确数值', async () => {
    const csv = await buildPlatformExport(novelId, platform)
    expect(csv).toContain('读完率区间')
    expect(csv).toContain('60-70%')
    expect(csv).not.toContain(platform)
    expect(csv).not.toContain('回到那一年')
    expect(csv).not.toContain('2000')
  })
})