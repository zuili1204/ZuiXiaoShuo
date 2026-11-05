import { describe, it, expect } from 'vitest'
import {
  checkQuality,
  mapFindingsToGate,
  runDeslopScripts,
  type DeslopFinding,
} from '../../../electron/services/quality-checker'

// P2-1：quality IPC 主进程实现单测。
// runDeslopScripts / checkQuality 会真实 spawn node 跑 story-review 的两个 deslop 脚本，
// appRoot 取 process.cwd()（vitest 以项目根为工作目录）。

const APP_ROOT = process.cwd()

const BAD_TEXT = [
  '老陈把信纸折好塞回信封，窗外的雨一直没有停，屋里安静得能听见挂钟走针的声音。',
  '他要的是道歉，不是解释。',
  '（此处省略200字）',
  '他起身走到桌边把台灯关掉房间一下子暗了下来只剩窗外的路灯照进一点光在墙上',
].join('\n')

const CLEAN_TEXT = [
  '雨停之后，巷子里的青石板泛着一层水光。林晚撑着伞走到邮局门口，把伞收起来，抖了抖上面的水珠。',
  '营业厅里只有一个窗口开着，前面排着一位老太太，正踮着脚往柜台上递一张汇款单。',
  '林晚等在黄线后面，顺手数了数墙上的信箱格：三排，一共四十八个。她记得上小学时帮母亲来取过信，那时候格子的漆皮就已经剥落了，如今还是老样子。',
  '轮到她时，她把稿子和回执一起递进去。柜员翻了翻，在回执上盖了章，又从抽屉里拿出一张收据推出来。',
  // IMP-04/05：规范为中文弯引号（人工稿 30 章 2246 处全部为弯引号，直角引号 0）
  '“姑娘，寄到省城的，三天能到。”柜员说。',
  '“麻烦您了。”她把收据折好放进帆布包，转身推门出去。',
  '太阳已经出来了，晒得人后背发暖。她沿着来时的路慢慢往回走，路过早点铺的时候买了一屉小笼包，想着回家给母亲热一热当午饭。',
].join('\n')

const finding = (over: Partial<DeslopFinding>): DeslopFinding => ({
  file: 'chapter.md',
  line: 1,
  column: 1,
  type: 'reverse-not-is',
  severity: 'blocking',
  message: '反序对比腔',
  excerpt: '是A，不是B',
  source: 'ai-patterns',
  ...over,
})

describe('mapFindingsToGate（findings → QualityGate 映射）', () => {
  it('无 findings：满分通过，deslopTag 为真', () => {
    const gate = mapFindingsToGate([])
    expect(gate.score).toBe(100)
    expect(gate.passed).toBe(true)
    expect(gate.deslopTag).toBe(true)
    expect(gate.aiPatternHits).toBe(0)
    expect(gate.degenerationHits).toBe(0)
    expect(gate.report).toContain('无 blocking')
  })

  it('有 blocking：不通过，deslopTag 取决于 AI 味脚本来源，score 按 blocking/advisory 扣分', () => {
    const gate = mapFindingsToGate([
      finding({ source: 'ai-patterns', severity: 'blocking' }),
      finding({ source: 'degeneration', type: 'truncated', severity: 'blocking', line: 4 }),
      finding({ source: 'ai-patterns', type: 'cliche-density-tic', severity: 'advisory' }),
      finding({ source: 'ai-patterns', type: 'period-stutter', severity: 'advisory', line: 9 }),
      finding({ source: 'ai-patterns', type: 'em-dash', severity: 'advisory', line: 10 }),
    ])
    expect(gate.passed).toBe(false)
    expect(gate.deslopTag).toBe(false)
    expect(gate.score).toBe(100 - 2 * 15 - 3 * 3)
    expect(gate.aiPatternHits).toBe(4)
    expect(gate.degenerationHits).toBe(1)
    expect(gate.report).toContain('blocking 2 处')
    expect(gate.report).toContain('第4行 [truncated]')
  })

  it('仅退化类 blocking（AI 味脚本干净）：不通过门禁但 deslopTag 为真', () => {
    const gate = mapFindingsToGate([
      finding({ source: 'degeneration', type: 'verbatim-repeat', severity: 'blocking' }),
    ])
    expect(gate.passed).toBe(false)
    expect(gate.deslopTag).toBe(true)
    expect(gate.degenerationHits).toBe(1)
  })

  it('仅 advisory：通过门禁，只扣提示分', () => {
    const gate = mapFindingsToGate([
      finding({ source: 'ai-patterns', type: 'long-paragraph', severity: 'advisory' }),
    ])
    expect(gate.passed).toBe(true)
    expect(gate.score).toBe(97)
  })

  it('F2：findings 逐条透传（行号/类型/严重度/摘要/来源）', () => {
    const gate = mapFindingsToGate([
      finding({ line: 7, type: 'reverse-not-is', message: '反序对比腔', excerpt: '是A，不是B' }),
      finding({ source: 'degeneration', type: 'truncated', severity: 'blocking', line: 9 }),
      finding({ source: 'style-metrics', type: 'style-metrics', severity: 'blocking', line: 12, excerpt: '' }),
    ])
    expect(gate.findings).toHaveLength(3)
    expect(gate.findings![0]).toEqual({
      line: 7, type: 'reverse-not-is', severity: 'blocking',
      message: '反序对比腔', excerpt: '是A，不是B', source: 'ai-patterns',
    })
    expect(gate.findings![1].source).toBe('degeneration')
    expect(gate.findings![2].source).toBe('style-metrics')
  })
})

describe('runDeslopScripts / checkQuality（真实 spawn deslop 脚本）', () => {
  it('退化 + AI 句式文本：两个脚本的 blocking 均被捕获并计入对应桶', async () => {
    const findings = await runDeslopScripts(BAD_TEXT, APP_ROOT)
    const types = findings.map((f) => f.type)
    expect(types).toContain('reverse-not-is') // ai-patterns 脚本
    expect(types).toContain('placeholder-leak') // degeneration 脚本
    expect(types).toContain('truncated') // degeneration 脚本
    expect(findings.every((f) => f.line > 0)).toBe(true)

    const gate = await checkQuality(BAD_TEXT, APP_ROOT)
    expect(gate.passed).toBe(false)
    expect(gate.deslopTag).toBe(false)
    expect(gate.score).toBeLessThan(60)
    expect(gate.aiPatternHits).toBeGreaterThanOrEqual(1)
    expect(gate.degenerationHits).toBeGreaterThanOrEqual(2)
    // F2：行级 findings 透传到 IPC 结果
    expect(gate.findings!.length).toBeGreaterThan(0)
    expect(gate.findings!.some((f) => f.type === 'placeholder-leak')).toBe(true)
  }, 30000)

  it('干净正文：零 findings，满分通过', async () => {
    const findings = await runDeslopScripts(CLEAN_TEXT, APP_ROOT)
    expect(findings).toEqual([])

    const gate = await checkQuality(CLEAN_TEXT, APP_ROOT)
    expect(gate.passed).toBe(true)
    expect(gate.score).toBe(100)
    expect(gate.aiPatternHits).toBe(0)
    expect(gate.degenerationHits).toBe(0)
  }, 30000)

  it('IMP-05：直角引号 / 英文引号 / 章末升华 被文风指标拦截', async () => {
    const dirty = [
      '「姑娘，寄到省城的，三天能到。」柜员说。',
      '她点点头，转身推门出去。',
      '这就是命运的意义，没有人知道明天会怎样。',
    ].join('\n')
    const gate = await checkQuality(dirty, APP_ROOT)
    expect(gate.passed).toBe(false)
    expect(gate.report).toMatch(/直角引号|英文直引号|章末升华/)
  }, 30000)

  it('正文过短（<50 字）：不跑脚本，直接零分不通过（与启发式口径一致）', async () => {
    const gate = await checkQuality('太短的正文。', APP_ROOT)
    expect(gate.score).toBe(0)
    expect(gate.passed).toBe(false)
    expect(gate.report).toContain('过短')
    expect(gate.findings).toEqual([])
  })

  it('脚本路径按 appRoot 解析且文件真实存在（防止打包/重命名后静默失配）', async () => {
    const { scriptPaths } = await import('../../../electron/services/quality-checker')
    const fs = await import('fs')
    const paths = scriptPaths(APP_ROOT)
    expect(fs.existsSync(paths.aiPatterns)).toBe(true)
    expect(fs.existsSync(paths.degeneration)).toBe(true)
  })
})
