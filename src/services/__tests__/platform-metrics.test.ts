import { describe, it, expect } from 'vitest'
import {
  buildMaskedCsv,
  buildTrend,
  compareHookChapters,
  findCompletionDrops,
  normalizeDate,
  parseChapterCsv,
  parseCommentsCsv,
  parseCsv,
  parseDailyCsv,
  parseNumber,
  parseRate,
  scoreComment,
  summarizeSentiment,
} from '@shared/platform-metrics'

describe('CSV 解析', () => {
  it('处理 BOM、引号内逗号与转义引号', () => {
    const { rows } = parseCsv('\uFEFF日期,内容\n2026-11-01,"你好,世界"\n2026-11-02,"他说""走走"""')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(['2026-11-01', '你好,世界'])
    expect(rows[2]).toEqual(['2026-11-02', '他说"走走"'])
  })

  it('每日数据支持表头、百分比与小数读完率', () => {
    const { rows, errors } = parseDailyCsv(
      '日期,阅读量,完读率,评论数,收益\n2026-11-01,"12,000",68%,86,35.5\n11/2,13500,0.66,102,41',
      new Date('2026-11-03T00:00:00'),
    )
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ date: '2026-11-01', reads: 12000, completionRate: 68, comments: 86, revenue: 35.5 })
    expect(rows[1]).toMatchObject({ date: '2026-11-02', reads: 13500, completionRate: 66 })
  })

  it('每日数据无表头时按位置解析，并报告无法识别的日期', () => {
    const { rows, errors } = parseDailyCsv('2026-11-01,100,50%,3,1\nxx,200,60%,4,2')
    expect(rows).toHaveLength(1)
    expect(rows[0].reads).toBe(100)
    expect(errors[0]).toContain('日期无法识别')
  })

  it('章节数据缺序号时按行号补齐', () => {
    const { rows, errors } = parseChapterCsv('章节,阅读,读完率,评论,收益\n第一章,100,70%,1,0\n第二章,90,60%,2,0')
    expect(errors).toHaveLength(0)
    expect(rows.map((r) => r.platformOrder)).toEqual([1, 2])
    expect(rows[1].platformChapterName).toBe('第二章')
  })

  it('评论数据支持表头与纯文本列表', () => {
    const withHeader = parseCommentsCsv('日期,章节,内容\n2026-11-01,第一章,好看，追了')
    expect(withHeader.rows[0]).toMatchObject({ date: '2026-11-01', platformChapterName: '第一章', content: '好看，追了' })

    const plainHeader = parseCommentsCsv('日期,章节,评论\n2026-11-01,第一章,太好看了')
    expect(plainHeader.rows[0].content).toBe('太好看了')

    const noHeader = parseCommentsCsv('第一条评论\n第二条评论')
    expect(noHeader.rows.map((r) => r.content)).toEqual(['第一条评论', '第二条评论'])
  })

  it('数字支持万、千单位', () => {
    expect(parseNumber('1.2万')).toBe(12000)
    expect(parseNumber('3.5亿')).toBe(350000000)
    expect(parseNumber('2千')).toBe(2000)
    expect(parseNumber('12,000')).toBe(12000)
  })

  it('读完率统一到 0~100 并夹取边界', () => {
    expect(parseRate('62%')).toBe(62)
    expect(parseRate('0.62')).toBe(62)
    expect(parseRate('62')).toBe(62)
    expect(parseRate('120%')).toBe(100)
    expect(parseRate('')).toBe(0)
  })

  it('日期支持多种写法并拒绝非法日期', () => {
    expect(normalizeDate('2026-11-01')).toBe('2026-11-01')
    expect(normalizeDate('2026/11/1')).toBe('2026-11-01')
    expect(normalizeDate('20261101')).toBe('2026-11-01')
    expect(normalizeDate('11/2', new Date('2026-11-03T00:00:00'))).toBe('2026-11-02')
    expect(normalizeDate('2026-02-30')).toBeNull()
    expect(normalizeDate('')).toBeNull()
  })
})

describe('趋势与异常', () => {
  it('趋势按前后 3 天均值判断方向，文案不下因果结论', () => {
    const trend = buildTrend([
      { date: '2026-11-01', reads: 2000, completionRate: 70, comments: 30, revenue: 10 },
      { date: '2026-11-02', reads: 1800, completionRate: 69, comments: 28, revenue: 9 },
      { date: '2026-11-03', reads: 1000, completionRate: 66, comments: 20, revenue: 8 },
      { date: '2026-11-04', reads: 900, completionRate: 64, comments: 18, revenue: 7 },
      { date: '2026-11-05', reads: 800, completionRate: 62, comments: 16, revenue: 6 },
    ])
    expect(trend.direction).toBe('down')
    expect(trend.readsDelta).toBeLessThan(0)
    expect(trend.points[0].date).toBe('2026-11-01')
    expect(trend.summary).toContain('不代表因果')
  })

  it('不足 3 章时不报异常', () => {
    const rows = [
      { chapterId: 'c1', chapterTitle: '一', platformChapterName: '一', platformOrder: 1, reads: 100, completionRate: 80, isHookChapter: false, wordCount: 2000 },
      { chapterId: 'c2', chapterTitle: '二', platformChapterName: '二', platformOrder: 2, reads: 80, completionRate: 60, isHookChapter: false, wordCount: 2000 },
    ]
    expect(findCompletionDrops(rows)).toHaveLength(0)
  })

  it('读完率明显低于相邻章时列为异常，并给出可能原因', () => {
    const rows = [
      { chapterId: 'c1', chapterTitle: '第一章', platformChapterName: '第一章', platformOrder: 1, reads: 1000, completionRate: 80, isHookChapter: true, wordCount: 2000 },
      { chapterId: 'c2', chapterTitle: '第二章', platformChapterName: '第二章', platformOrder: 2, reads: 900, completionRate: 78, isHookChapter: false, wordCount: 2000 },
      { chapterId: 'c3', chapterTitle: '第三章', platformChapterName: '第三章', platformOrder: 3, reads: 500, completionRate: 40, isHookChapter: false, wordCount: 4200 },
      { chapterId: 'c4', chapterTitle: '第四章', platformChapterName: '第四章', platformOrder: 4, reads: 850, completionRate: 76, isHookChapter: false, wordCount: 2000 },
    ]
    const drops = findCompletionDrops(rows, { threshold: 12 })
    expect(drops).toHaveLength(1)
    expect(drops[0].chapterId).toBe('c3')
    expect(drops[0].drop).toBeGreaterThanOrEqual(30)
    expect(drops[0].possibleCauses.length).toBeGreaterThan(0)
    expect(drops[0].possibleCauses.join('')).toContain('篇幅偏长')
  })
})

describe('评论情绪与钩子对比', () => {
  it('正负向词表给出 -1~1 分数并汇总', () => {
    expect(scoreComment('太好看了，追了')).toBeGreaterThan(0)
    expect(scoreComment('这章太水了，追不下去')).toBeLessThan(0)
    expect(scoreComment('普通的一天')).toBe(0)

    const summary = summarizeSentiment([
      { content: '太好看了，追了' },
      { content: '这章太水了，追不下去' },
      { content: '今天下雨' },
    ])
    expect(summary.total).toBe(3)
    expect(summary.positive).toBe(1)
    expect(summary.negative).toBe(1)
    expect(summary.neutral).toBe(1)
    expect(summary.samples.length).toBeGreaterThan(0)
  })

  it('钩子章与普通章给出均值与相关性提示', () => {
    const comparison = compareHookChapters([
      { completionRate: 80, isHookChapter: true },
      { completionRate: 82, isHookChapter: true },
      { completionRate: 60, isHookChapter: false },
      { completionRate: 58, isHookChapter: false },
    ])
    expect(comparison.hookCount).toBe(2)
    expect(comparison.normalCount).toBe(2)
    expect(comparison.hookAvg).toBeGreaterThan(comparison.normalAvg)
    expect(comparison.note).toContain('不代表因果')
  })
})

describe('脱敏导出', () => {
  it('只输出日期/序号与区间，不含平台名、章节名和精确值', () => {
    const csv = buildMaskedCsv(
      [{ date: '2026-11-01', reads: 12345, completionRate: 68, comments: 86, revenue: 35.5 }],
      [{ platformOrder: 3, reads: 9000, completionRate: 41, comments: 20, revenue: 12 }],
    )
    expect(csv).toContain('1 万以上')
    expect(csv).toContain('60-70%')
    expect(csv).toContain('第 3 章')
    expect(csv).not.toContain('12345')
    expect(csv).not.toContain('起点')
    expect(csv).not.toContain('正文')
  })
})