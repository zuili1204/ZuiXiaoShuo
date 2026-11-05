import { describe, it, expect, vi, afterEach } from 'vitest'
import { evaluatePipelineGate } from '../pipeline-gate'

// consistency-service 顶部导入 data-service；门禁单测不触库
vi.mock('../data-service', () => ({
  volumeService: { getByNovelId: vi.fn(async () => []) },
  chapterService: { getByVolumeId: vi.fn(async () => []) },
  characterService: { getByNovelId: vi.fn(async () => []) },
  foreshadowingService: { getByNovelId: vi.fn(async () => []) },
}))

const AI_HEAVY_TEXT =
  '首先，我们需要明确故事的背景。其次，主角的内心充满了矛盾。最后，剧情达到了高潮。' +
  '总体而言，这是一个值得深思的结局。显而易见，作者的笔触十分细腻。' +
  '值得注意的是，这样的写法在网文里并不少见，综上所述，应当保持克制。'

function seedScriptQuality(result: Record<string, unknown>) {
  const check = vi.fn(async () => result)
  ;(window as any).electronAPI = { quality: { check } }
  return check
}

afterEach(() => {
  delete (window as any).electronAPI
})

describe('evaluatePipelineGate（流水线门禁与保存钩子统一口径）', () => {
  it('主进程脚本可用时以脚本结果为准，不走启发式', async () => {
    // 文本本身满是 AI 句式（启发式必拦截），脚本判定通过 → 以脚本为准
    const check = seedScriptQuality({
      score: 88,
      passed: true,
      deslopTag: true,
      aiPatternHits: 0,
      degenerationHits: 0,
      report: '确定性脚本报告',
    })
    const g = await evaluatePipelineGate(AI_HEAVY_TEXT)
    expect(check).toHaveBeenCalledTimes(1)
    expect(g.score).toBe(88)
    expect(g.passed).toBe(true)
    expect(g.report).toBe('确定性脚本报告')
  })

  it('脚本 findings 原样透传，供流水线面板定位问题行', async () => {
    const findings = [
      { line: 2, type: 'reverse-not-is', severity: 'blocking', message: '反序对比腔', excerpt: '是A，不是B', source: 'ai-patterns' },
    ]
    seedScriptQuality({ score: 70, passed: false, deslopTag: false, aiPatternHits: 1, degenerationHits: 0, report: '有问题', findings })
    const g = await evaluatePipelineGate('一段足够长的正文内容，用于验证脚本 findings 是否透传。')
    expect(g.findings).toEqual(findings)
  })

  it('伏笔对账错配 → 即使脚本通过也拦截，报告合并两方结论', async () => {
    seedScriptQuality({
      score: 92,
      passed: true,
      deslopTag: true,
      aiPatternHits: 0,
      degenerationHits: 0,
      report: '确定性脚本报告',
    })
    const g = await evaluatePipelineGate('他终于明白当年字条的含义 [F-7 回收]，却没人记得字条从何而来。')
    expect(g.passed).toBe(false)
    expect(g.deslopTag).toBe(false)
    expect(g.report).toContain('确定性脚本报告')
    expect(g.report).toContain('伏笔对账')
    expect(g.report).toContain('回收无埋设')
  })

  it('同章即收同样拦截', async () => {
    seedScriptQuality({ score: 90, passed: true, deslopTag: true, aiPatternHits: 0, degenerationHits: 0, report: 'ok' })
    const g = await evaluatePipelineGate('他发现字条 [F-2 埋设]，下一页就写明了答案 [F-2 回收]。')
    expect(g.passed).toBe(false)
    expect(g.report).toContain('同章即收')
  })

  it('无脚本环境降级启发式，且埋设未回收不误杀', async () => {
    const text = '林晚推开那扇斑驳的木门，灰尘扑簌簌落下来。她屏住呼吸，听见院里老槐树在风里沙沙作响。' +
      '三年了，这院子还是老样子，只是再没有人为她留灯。她攥紧袖中的玉佩，一步步走进黑暗。'
    const plain = await evaluatePipelineGate(text)
    expect(plain.passed).toBe(true)

    const withDangling = await evaluatePipelineGate(`${text}\n[F-9 埋设] 玉佩上多了一道裂纹。`)
    expect(withDangling.passed).toBe(true)
    expect(withDangling.report).toContain('未回收（中间态）')
  })

  it('空文本降级路径不通过', async () => {
    const g = await evaluatePipelineGate('')
    expect(g.passed).toBe(false)
    expect(g.score).toBe(0)
  })
})
