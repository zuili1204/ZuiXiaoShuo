import { describe, it, expect } from 'vitest'
import { splitChapters, splitDirectoryFiles, hashText, normalizeCorpusText } from '@shared/chapter-split'
import {
  aggregateStyleMetrics,
  classifyEnding,
  classifyOpening,
  computeStyleMetrics,
  computeTitleMetrics,
  metricsToAxes,
  sampleChapterIndexes,
} from '@shared/style-metrics'

describe('语料切章', () => {
  it('按章节标记切分并跳过简介/目录', () => {
    const raw = [
      '作品简介',
      '这是一段简介。',
      '第一章 雪夜',
      '他推门而入。'.repeat(60),
      '第二章 旧案',
      '她翻开卷宗。'.repeat(60),
      '完本感言',
      '谢谢大家。',
    ].join('\n')
    const result = splitChapters(raw)
    expect(result.splitMode).toBe('chapter_markers')
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 雪夜', '第二章 旧案'])
    expect(result.totalChars).toBeGreaterThan(0)
  })

  it('无章节标记时按分析块切分，不丢正文', () => {
    const paragraph = '风从山谷里吹来，带着雪的味道。'.repeat(200)
    const second = '火光在窗纸上晃动，屋里没有人说话。'.repeat(200)
    const result = splitChapters(`${paragraph}\n\n${second}`)
    expect(result.splitMode).toBe('analysis_blocks')
    expect(result.chapters.length).toBeGreaterThan(1)
    expect(result.chapters.map((c) => c.content).join('')).toContain('风从山谷里吹来')
  })

  it('重复正文只保留一份', () => {
    const body = '同样的正文。'.repeat(80)
    const raw = `第一章 甲\n${body}\n第二章 乙\n${body}`
    const result = splitChapters(raw)
    expect(result.chapters).toHaveLength(1)
    expect(result.duplicateChapters).toBe(1)
  })

  it('目录导入按文件名自然序，空文件跳过', () => {
    const result = splitDirectoryFiles([
      { name: '第10章.txt', content: '十'.repeat(600) },
      { name: '第2章.txt', content: '二'.repeat(600) },
      { name: '空章.txt', content: '   ' },
    ])
    expect(result.splitMode).toBe('directory')
    expect(result.chapters.map((c) => c.title)).toEqual(['第2章', '第10章'])
  })

  it('hashText 稳定且归一化不改变语义', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
    expect(normalizeCorpusText('a\r\n\r\n\r\nb  ')).toBe('a\n\nb')
  })
})

describe('文风定量指标', () => {
  const text = [
    '他推门。',
    '“你来晚了。”她说。',
    '屋里很冷，像冰窖一样。',
    '他心里一沉，却还是笑了。',
  ].join('\n')

  it('识别短句、对话、比喻、心理与章末钩子', () => {
    const m = computeStyleMetrics(text)
    expect(m.sentenceCount).toBeGreaterThan(0)
    expect(m.shortSentencePct).toBeGreaterThan(0)
    expect(m.dialogueCount).toBe(1)
    expect(m.dialoguePct).toBeGreaterThan(0)
    expect(m.simileStrictPer1k).toBeGreaterThan(0)
    expect(m.interiorityPct).toBeGreaterThan(0)
  })

  it('章末问号/省略号算钩子', () => {
    expect(computeStyleMetrics('他到底去了哪里？').hookEnding).toBe(true)
    expect(computeStyleMetrics('他回家吃饭。').hookEnding).toBe(false)
  })

  it('多章聚合按字数加权，空样本返回全 0', () => {
    const axes = aggregateStyleMetrics([
      { content: '短句。短句。'.repeat(20) },
      { content: '这是一段明显更长的句子，用来拉高平均句长。'.repeat(20) },
    ])
    expect(axes.sentenceAvgLen).toBeGreaterThan(0)
    expect(axes.chapterAvgLen).toBeGreaterThan(0)
    expect(aggregateStyleMetrics([]).chapterAvgLen).toBe(0)
  })

  it('单章指标转为可比轴', () => {
    const axes = metricsToAxes(computeStyleMetrics(text))
    expect(axes.chapterAvgLen).toBeGreaterThan(0)
    expect(axes.hookEndingPct).toBe(0)
  })

  it('抽样确定性：首/中/末必含且数量正确', () => {
    const a = sampleChapterIndexes(100, 12)
    const b = sampleChapterIndexes(100, 12)
    expect(a).toEqual(b)
    expect(a).toHaveLength(12)
    expect(a).toContain(0)
    expect(a).toContain(99)
    expect(a).toContain(50)
    expect(sampleChapterIndexes(5, 24)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('节奏与章节工程指标', () => {
  it('识别开篇方式与章末类型', () => {
    expect(classifyOpening('“你来了。”他说。')).toBe('dialogue')
    expect(classifyOpening('他推门而入。')).toBe('continuation')
    expect(classifyOpening('清晨，雪停了。')).toBe('time')
    expect(classifyEnding('桌上还放着半块橡皮。')).toBe('image')
    expect(classifyEnding('“明天见。”')).toBe('dialogue')
    expect(classifyEnding('他到底去了哪里？')).toBe('question')
    expect(classifyEnding('他终于明白，这一切都是成长。')).toBe('summary')
  })

  it('统计标点节奏、具体物件与禁忌', () => {
    const text = '他攥着手机……“走吗？”\n（别问了）桌上还有半块橡皮！\n代价是失去她，这是宿命。'
    const m = computeStyleMetrics(text)
    expect(m.ellipsisCount).toBeGreaterThan(0)
    expect(m.questionCount).toBe(1)
    expect(m.exclaimCount).toBe(1)
    expect(m.parentheticalCount).toBe(1)
    expect(m.concreteObjectHits).toBeGreaterThanOrEqual(2)
    expect(m.tabooHits).toBeGreaterThan(0)
    expect(m.openingType).toBe('continuation')
    expect(m.endingType).toBe('summary')
  })

  it('标题工程按名字、感叹、问号与分段统计', () => {
    const metrics = computeTitleMetrics(['林川的雪夜', '第十话／走吗？', '终点！', '甲／乙'], ['林川'])
    expect(metrics.namePct).toBe(25)
    expect(metrics.questionPct).toBe(25)
    expect(metrics.exclaimPct).toBe(25)
    expect(metrics.multiPartPct).toBe(50)
  })

  it('多章聚合回填标题与公共事件/禁忌比例', () => {
    const axes = aggregateStyleMetrics(
      [
        { title: '林川的雪夜', content: '他去了运动会。'.repeat(300) },
        { title: '放学以后', content: '她翻开作业本。'.repeat(300) },
      ],
      { names: ['林川'] },
    )
    expect(axes.titleNamePct).toBe(50)
    expect(axes.publicEventPerChapter).toBeGreaterThan(0)
    expect(axes.tabooRatio).toBe(0)
  })
})
