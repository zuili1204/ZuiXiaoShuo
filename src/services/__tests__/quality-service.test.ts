import { describe, it, expect, afterEach } from 'vitest'
import { estimateQualityGate, runQualityGate } from '../quality-service'

describe('P0 质量门禁（去AI味检测）', () => {
  it('空文本不通过门禁', () => {
    const g = estimateQualityGate('')
    expect(g.passed).toBe(false)
    expect(g.score).toBe(0)
  })

  it('自然网文正文通过门禁', () => {
    const text =
      '林晚推开那扇斑驳的木门，灰尘扑簌簌落下来。她屏住呼吸，听见院里老槐树在风里沙沙作响。' +
      '三年了，这院子还是老样子，只是再没有人为她留灯。她攥紧袖中的玉佩，一步步走进黑暗。'
    const g = estimateQualityGate(text)
    expect(g.aiPatternHits).toBe(0)
    expect(g.passed).toBe(true)
    expect(g.deslopTag).toBe(true)
    expect(g.score).toBeGreaterThan(60)
  })

  it('AI 套路句式触发拦截', () => {
    const text =
      '首先，我们需要明确故事的背景。其次，主角的内心充满了矛盾。最后，剧情达到了高潮。' +
      '总体而言，这是一个值得深思的结局。显而易见，作者的笔触十分细腻。'
    const g = estimateQualityGate(text)
    expect(g.aiPatternHits).toBeGreaterThan(0)
    expect(g.passed).toBe(false)
    expect(g.deslopTag).toBe(false)
  })

  it('退化文本（复读/工程标点）被扣分', () => {
    const text = '他走了。他走了。他走了。他走了。'.repeat(20)
    const g = estimateQualityGate(text)
    expect(g.degenerationHits).toBeGreaterThan(0)
    expect(g.score).toBeLessThan(70)
  })
})

describe('F2：runQualityGate findings 透传（手动 AI 率检测用）', () => {
  afterEach(() => {
    delete (window as any).electronAPI
  })

  it('主进程结果带 findings 时原样透传', async () => {
    const findings = [
      { line: 3, type: 'reverse-not-is', severity: 'blocking', message: '反序对比腔', excerpt: '是A，不是B', source: 'ai-patterns' },
    ]
    ;(window as any).electronAPI = {
      quality: {
        check: async () => ({
          score: 85, passed: true, deslopTag: true, aiPatternHits: 1, degenerationHits: 0,
          report: 'ok', findings,
        }),
      },
    }
    const g = await runQualityGate('足够长的正文，超过五十字的门槛，让主进程路径被走到。')
    expect(g.findings).toEqual(findings)
  })

  it('主进程无 findings 字段时不误造空数组以外的值', async () => {
    ;(window as any).electronAPI = {
      quality: {
        check: async () => ({ score: 90, passed: true, deslopTag: true, aiPatternHits: 0, degenerationHits: 0, report: 'ok' }),
      },
    }
    const g = await runQualityGate('足够长的正文，超过五十字的门槛，让主进程路径被走到。')
    expect(g.findings).toBeUndefined()
  })

  it('启发式降级（无 electronAPI）不含 findings', async () => {
    const g = await runQualityGate('')
    expect(g.findings).toBeUndefined()
  })
})
