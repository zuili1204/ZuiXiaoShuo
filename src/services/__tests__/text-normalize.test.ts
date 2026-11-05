import { describe, it, expect } from 'vitest'
import { normalizeText } from '../text-normalize'

describe('text-normalize · IMP-04 标点统一', () => {
  it('直角引号 → 中文弯引号（开闭固定，零歧义）', () => {
    const { text, details } = normalizeText('「江砚！交作业的！」他说。')
    expect(text).toBe('“江砚！交作业的！”他说。')
    expect(details.cornerQuotes).toBe(2)
  })

  it('书名号/强调标记的「」保留原样（人工稿「校刊」即此用法）', () => {
    const raw = '「校刊」＋「值日表」＋「旧书摊」'
    const { text, changes } = normalizeText(raw)
    expect(text).toBe(raw)
    expect(changes).toBe(0)
  })

  it('英文直引号成对 → 中文弯引号', () => {
    const { text, details } = normalizeText('"起来。再试一次。"')
    expect(text).toBe('“起来。再试一次。”')
    expect(details.straightQuotes).toBe(2)
  })

  it('英文直引号奇数个 = 配对不完整，整行保留原样（宁可不改）', () => {
    const { text, details } = normalizeText('他说"这是什么')
    expect(text).toBe('他说"这是什么')
    expect(details.straightQuotes).toBe(0)
  })

  it('中英文空格默认关闭（人工稿不使用该风格：写「选C」「ABD的用法」）', () => {
    const { text, changes } = normalizeText('他不知道Gucci是什么')
    expect(text).toBe('他不知道Gucci是什么')
    expect(changes).toBe(0)
  })

  it('中英文空格：显式开启时才生效，且只处理字母不碰数字', () => {
    const { text } = normalizeText('他不知道Gucci是什么', { addCnEnSpace: true })
    expect(text).toBe('他不知道 Gucci 是什么')
    // 数字仍不受影响
    const r2 = normalizeText('时间跨度从2025年', { addCnEnSpace: true })
    expect(r2.text).toBe('时间跨度从2025年')
  })

  it('中文 + 数字不受影响（防误杀：人工稿大量「年10月」）', () => {
    const { text, changes } = normalizeText('时间跨度从2025年跳转到了足足11年之后的2036年！')
    expect(text).toBe('时间跨度从2025年跳转到了足足11年之后的2036年！')
    expect(changes).toBe(0)
  })

  it('易混词白名单替换', () => {
    const { text, details } = normalizeText('做为市长，他才意思到，自己买不起也买的起是两回事')
    expect(text).toContain('作为市长')
    expect(text).toContain('意识到')
    expect(text).not.toContain('做为')
    expect(details.typoFixes).toBeGreaterThan(0)
  })

  it('代码块围栏内原样保留', () => {
    const raw = '```\nconst a = "x"\n```'
    const { text } = normalizeText(raw)
    expect(text).toBe(raw)
  })

  it('含 URL 的行不做引号转换（避免破坏链接）', () => {
    const raw = '见 https://a.com/b"c'
    const { text } = normalizeText(raw)
    expect(text).toBe(raw)
  })

  // ===== 防误杀回归：真实人工稿片段必须零改动 =====
  it('人工稿真实片段：零改动（本就规范，任何改动都是 bug）', () => {
    const human = [
      '“话说你下午打球不？”吃饭的时候，许舟朝江砚问道。',
      '“不打。”江砚摇摇头，“我下午有事。”',
      '【江砚】：老师说报名费每月月底交，一个月200，这边跟你确认一下。',
      '【周姨】：对的对的。',
      '【2025年6月20日，星期五】',
      '江砚还依稀记得，临江中学一个学期光是学费就得八千，一年就是一万六。',
      '穿着校服，江砚也看不出对方的身材，但光是这一张脸，就足以让人印象深刻。',
      '卧槽！',
      '兄弟你闹哪样啊！？',
    ].join('\n')

    const { text, changes } = normalizeText(human)
    expect(changes).toBe(0)
    expect(text).toBe(human)
  })

  it('AI 稿真实片段：三套引号 + 中英文粘连被统一', () => {
    const ai = [
      '「江砚！交作业的！」是周遥的嗓门。',
      '"起来。再试一次。"',
      '他不知道Gucci是什么，做为班长也很难意思到。',
    ].join('\n')

    const { text, details } = normalizeText(ai)
    expect(text).not.toContain('「')
    expect(text).not.toContain('」')
    expect(text).not.toContain('"')
    expect(text).toContain('“江砚！交作业的！”')
    expect(text).toContain('“起来。再试一次。”')
    expect(text).toContain('作为班长')
    expect(details.cornerQuotes).toBe(2)
    expect(details.straightQuotes).toBe(2)
  })
})
