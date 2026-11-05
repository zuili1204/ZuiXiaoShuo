const { describe, it, expect } = globalThis
const lib = require('./style-metrics-lib.cjs')

const HUMAN_SAMPLE = [
  '“话说你下午去社团不？”吃饭的时候，许舟朝江砚问道。',
  '“不去。”江砚摇摇头，“我下午有事。”',
  '【江砚】：老师说报名费每月月底交，一个月200，这边跟你确认一下。',
  '江砚还依稀记得，临江中学一个学期光是学费就得八千，一年就是一万六。',
].join('\n')

const AI_SAMPLE = [
  '「江砚！交作业的！」是周遥的嗓门，中气十足。',
  '窗外，隐约有一句话飘进来，又轻又淡，像是从很远的地方贴着水面飘来的。',
  '他不知道Gucci是什么，做为班长也很难意思到。',
  '高三，就在这个湿热得化不开的夜里，悄悄拉开了幕。',
].join('\n')

describe('style-metrics-lib · IMP-09', () => {
  it('computeMetrics：统计引号三态与基本指标', () => {
    const m = lib.computeMetrics(AI_SAMPLE)
    expect(m.quotes.corner).toBe(2)
    expect(m.quotes.curly).toBe(0)
    expect(m.chars).toBeGreaterThan(0)
    expect(m.paragraph.avgLen).toBeGreaterThan(0)
  })

  it('computeMetrics：章末升华能被检出', () => {
    const m = lib.computeMetrics(AI_SAMPLE)
    expect(m.chapterEndSublime).toBe(true)
  })

  it('人工稿样本：0 blocking（门禁不应误杀）', () => {
    const m = lib.computeMetrics(HUMAN_SAMPLE)
    const gate = lib.gateChapter(m)
    expect(gate.blocking).toHaveLength(0)
  })

  it('AI 稿样本：直角引号触发 blocking', () => {
    const m = lib.computeMetrics(AI_SAMPLE)
    const gate = lib.gateChapter(m)
    expect(gate.blocking.some((b) => b.includes('直角引号'))).toBe(true)
  })

  it('分级原则：比喻密度等密度类指标为 warning，不是 blocking', () => {
    const t = lib.THRESHOLDS
    expect(t.similePer1k.level).toBe('warning')
    expect(t.climatePer1k.level).toBe('warning')
    expect(t.minChars.level).toBe('warning')
    // 零歧义硬伤必须是 blocking
    expect(t.cornerQuote.level).toBe('blocking')
    expect(t.straightQuote.level).toBe('blocking')
    expect(t.chapterEndSublime.level).toBe('blocking')
  })

  it('cleanHtml：去除 </p><p> 污染并保留段落', () => {
    const raw = '<div id="a"><p>第一段</p><p>第二段</p></div>'
    const out = lib.cleanHtml(raw)
    expect(out).not.toContain('<p>')
    expect(out).not.toContain('</p>')
    expect(out).toContain('第一段')
    // cleanHtml 保留尾随换行，故按非空行计
    expect(out.split('\n').filter(Boolean).length).toBe(2)
  })

  it('computeMetrics：excludeNames 剔除人名，气候词不再把人名计入（q22 效度修复）', () => {
    const t = '林雨晴没说话。外面下着雨，她的袖口全湿了。'
    const plain = lib.computeMetrics(t)
    const named = lib.computeMetrics(t, { excludeNames: ['林雨晴'] })
    expect(plain.climateHits).toBe(3)
    expect(named.climateHits).toBe(2)
    expect(named.climateExcluded).toBe(1)
    expect(named.climatePer1k).toBeLessThan(plain.climatePer1k)
  })

  it('computeMetrics：比喻双口径——strict 修辞口径扣除揣测用法（q22 效度修复）', () => {
    const t = '他好像忘了带伞。她像一只受惊的猫，缩在墙角。他像是在等人。'
    const m = lib.computeMetrics(t)
    expect(m.simileHits).toBe(3)
    expect(m.simileHedgeHits).toBe(2) // “好像”“像是在”是揣测，不是修辞
    expect(m.simileStrictHits).toBe(1) // 只剩真修辞“像一只受惊的猫”
    expect(m.simileStrictPer1k).toBeLessThan(m.similePer1k)
  })

  it('门禁维持全量口径：THRESHOLDS 不含 strict 字段，防止放水', () => {
    expect(lib.THRESHOLDS.similePer1k).toBeDefined()
    expect(lib.THRESHOLDS.simileStrictPer1k).toBeUndefined()
  })
})
