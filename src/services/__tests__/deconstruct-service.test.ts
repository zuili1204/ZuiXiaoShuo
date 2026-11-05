import { describe, it, expect, beforeEach, vi } from 'vitest'

// F4：拆书服务单测。mock ai-outline（getAgent/callLLM），extractJson 保留真实实现。
// 覆盖：采样逻辑、无 Agent 报错、JSON 解析失败降级、正常流水线产物校验。

vi.mock('../ai-outline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-outline')>()
  return {
    ...actual,
    getAgent: vi.fn(),
    callLLM: vi.fn(),
  }
})

vi.mock('../template-service', () => ({
  saveUserTemplate: vi.fn(async () => {}),
}))

import { sampleChapterIndexes, deconstructBook } from '../deconstruct-service'
import { getAgent, callLLM } from '../ai-outline'
import { saveUserTemplate } from '../template-service'

const getAgentMock = getAgent as ReturnType<typeof vi.fn>
const callLLMMock = callLLM as ReturnType<typeof vi.fn>

// 构造多章文本：每章 >100 字才会被 parseTextFile 收录；正文避免出现「第N章」字样干扰切章正则
function makeBook(chapterCount: number): string {
  const parts: string[] = []
  for (let i = 1; i <= chapterCount; i++) {
    parts.push(`第${i}章 试炼之路\n`)
    parts.push('这是本章的正文内容，情节持续推进，人物轮番登场，冲突逐步升级。'.repeat(12))
    parts.push('\n')
  }
  return parts.join('\n')
}

const CHAPTER_JSON = JSON.stringify({
  scene: '主角在山门被人拦下',
  characters: [{ name: '林尘', role: 'protagonist', profile: '外门弟子，意志坚定' }],
  beats: ['被拦', '冲突', '显露天赋'],
  worldbuilding: ['灵根分级'],
  style: '第三人称，短句为主',
})

const MAIN_JSON = JSON.stringify({
  masterOutline: '废材少年逆袭成至强者',
  volumes: [
    { title: '第一卷 入门', summary: '进入宗门站稳脚跟' },
    { title: '第二卷 崛起', summary: '崭露头角招来强敌' },
  ],
})

const SETTING_JSON = JSON.stringify({
  genre: '玄幻',
  genres: ['玄幻', '修仙'],
  blurb: '废材逆天改命',
  description: '一个被废掉灵根的少年，靠着神秘古塔逆天改命。',
  characters: [{ name: '林尘', role: '主角', profile: '主角' }],
  worldview: [
    { category: '力量体系', title: '灵根', content: '分九品' },
    { category: 'society', title: '宗门', content: '青云宗' },
  ],
})

const GOLDEN_JSON = JSON.stringify({
  chapters: [
    { title: '废灵根', hooks: ['灵根被夺', '神秘古塔现世'] },
    { title: '古塔', hooks: ['塔中老人', '第一条功法'] },
    { title: '立誓', hooks: ['三年之约'] },
  ],
})

// callLLM 分发：按提示词关键词路由到不同 JSON
function routeLLM() {
  callLLMMock.mockImplementation(async (_agent: unknown, _novelId: string, prompt: string) => {
    if (prompt.includes('拆解师')) return CHAPTER_JSON
    if (prompt.includes('汇总全书主线与分卷')) return MAIN_JSON
    if (prompt.includes('汇总角色阵容、世界观条目')) return SETTING_JSON
    if (prompt.includes('前三章骨架')) return GOLDEN_JSON
    return ''
  })
}

async function collect(gen: AsyncGenerator<unknown>) {
  const events: unknown[] = []
  let final: unknown
  for (;;) {
    const { value, done } = await gen.next()
    if (done) {
      final = value
      break
    }
    events.push(value)
  }
  return { events, final }
}

describe('sampleChapterIndexes（采样逻辑）', () => {
  it('总数不超过上限时全取', () => {
    expect(sampleChapterIndexes(10, 30)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('超上限时数量收敛且首/中/末必含、有序去重', () => {
    const idx = sampleChapterIndexes(200, 30)
    expect(idx.length).toBeLessThanOrEqual(30)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(199)
    expect(idx).toContain(100)
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1])
  })
})

describe('deconstructBook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未配置 Agent 时直接报错', async () => {
    getAgentMock.mockResolvedValue(null)
    const { events } = await collect(deconstructBook(makeBook(3), '测试书.txt'))
    expect(events[0]).toMatchObject({ phase: 'error' })
    expect(callLLMMock).not.toHaveBeenCalled()
  })

  it('正常流水线：逐章调用 LLM，模板产物合规且落盘', async () => {
    getAgentMock.mockResolvedValue({ id: 'a1' })
    routeLLM()
    const { events, final } = await collect(deconstructBook(makeBook(5), '测试书.txt'))

    const phases = (events as { phase: string }[]).map((e) => e.phase)
    expect(phases[0]).toBe('parse')
    expect(phases).toContain('analyze')
    expect(phases).toContain('summarize')
    expect(phases).toContain('template')
    expect(phases[phases.length - 1]).toBe('done')

    // 5 章全部采样 + 3 次汇总 = 8 次调用
    expect(callLLMMock).toHaveBeenCalledTimes(8)
    // 单章正文截断参与分析（提示词含章节标题）
    expect(callLLMMock.mock.calls[0][2]).toContain('第1章')

    expect(saveUserTemplate).toHaveBeenCalledTimes(1)
    const tpl = (saveUserTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(tpl.id).toBe('测试书-deconstruct')
    expect(tpl.name).toBe('测试书（拆书）')
    expect(tpl.genres).toEqual(['玄幻', '修仙'])
    // role 中文「主角」映射为 protagonist；category 中文「力量体系」映射为 power
    expect(tpl.characters[0]).toEqual({ name: '林尘', role: 'protagonist', profile: '主角' })
    expect(tpl.worldviewEntries[0]).toEqual({ category: 'power', title: '灵根', content: '分九品' })
    expect(tpl.worldviewEntries[1].category).toBe('society')
    expect(tpl.masterPlan.volumes).toHaveLength(2)
    expect(tpl.masterPlan.masterOutline).toContain('逆袭')
    expect(tpl.goldenThree).toHaveLength(3)
    expect(tpl.goldenThree.every((c: { hooks: string[] }) => c.hooks.length >= 1)).toBe(true)

    expect(final).toMatchObject({ sampledChapters: 5, totalChapters: 5, templateId: '测试书-deconstruct' })
  })

  it('LLM 输出坏 JSON 时降级为启发式，仍产出可用模板', async () => {
    getAgentMock.mockResolvedValue({ id: 'a1' })
    callLLMMock.mockResolvedValue('这不是 JSON')
    const { final } = await collect(deconstructBook(makeBook(4), '测试书.txt'))

    expect(saveUserTemplate).toHaveBeenCalledTimes(1)
    const tpl = (saveUserTemplate as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // 前三章骨架降级为默认标题
    expect(tpl.goldenThree.map((c: { title: string }) => c.title)).toEqual(['第1章', '第2章', '第3章'])
    // 分卷降级为单卷
    expect(tpl.masterPlan.volumes).toHaveLength(1)
    // 简介示例回退到 parseTextFile 的启发式简介
    expect(tpl.descriptionExample.length).toBeGreaterThan(0)
    expect(final).toMatchObject({ sampledChapters: 4, totalChapters: 4 })
  })
})
