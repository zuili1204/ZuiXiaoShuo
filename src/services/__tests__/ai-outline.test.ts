import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '@shared/types'
import { buildOutline, refineOutline } from '../ai-outline'

// ===== mock 状态（vi.mock 工厂仅在回调期读取，避免 TDZ）=====
const mockStore = {
  agents: [] as any[],
  volumes: [] as any[],
  chapters: [] as any[],
  content: {} as Record<string, string>,
  updates: [] as { kind: string; id: string; patch: any }[],
  kbWrites: [] as { file: string; content: string; origin: string }[],
  kbOutline: '' as string,
  syncCalls: [] as string[],
  chatQueue: [] as (string | Error)[],
  prompts: [] as string[],
}

vi.mock('../data-service', () => ({
  agentConfigService: {
    getAll: vi.fn(async () => mockStore.agents),
  },
  volumeService: {
    getByNovelId: vi.fn(async () => mockStore.volumes),
    update: vi.fn(async (id: string, patch: any) => {
      mockStore.updates.push({ kind: 'volume', id, patch })
    }),
  },
  chapterService: {
    getByVolumeId: vi.fn(async (vid: string) => mockStore.chapters.filter((c) => c.volumeId === vid)),
    getById: vi.fn(async (id: string) => mockStore.chapters.find((c) => c.id === id) ?? null),
    loadContent: vi.fn(async (id: string) => mockStore.content[id] ?? ''),
    update: vi.fn(async (id: string, patch: any) => {
      mockStore.updates.push({ kind: 'chapter', id, patch })
    }),
  },
}))

vi.mock('../agent-service', () => ({
  agentChat: vi.fn(async function* (_agent: any, prompt: string, _opts: any, _signal?: any) {
    mockStore.prompts.push(prompt)
    const next = mockStore.chatQueue.shift()
    if (next instanceof Error) throw next
    if (next) yield { content: next, done: false }
    yield { content: '', done: true }
  }),
}))

vi.mock('../knowledge-service', () => ({
  knowledgeService: {
    write: vi.fn(async (_n: string, file: string, content: string, origin: string) => {
      mockStore.kbWrites.push({ file, content, origin })
    }),
    read: vi.fn(async () => mockStore.kbOutline),
    syncOutline: vi.fn(async () => {
      mockStore.syncCalls.push('outline')
    }),
  },
}))

const agent: AgentConfig = {
  role: 'writer',
  name: 'writer',
  systemPrompt: 'sys',
  apiKeyEncrypted: 'k',
  provider: 'openai',
  model: 'gpt',
} as unknown as AgentConfig

const NOVEL = 'novel-1'
const VOL1 = 'vol-1'
const CH1 = 'ch-1'
const CH2 = 'ch-2'

function seedOneVolumeWithTwoChapters() {
  mockStore.volumes = [{ id: VOL1, novelId: NOVEL, title: '第一卷', order: 1, summary: '' }]
  mockStore.chapters = [
    { id: CH1, volumeId: VOL1, title: '第一章', order: 1, summary: '已有摘要一', hooks: [] },
    { id: CH2, volumeId: VOL1, title: '第二章', order: 2, summary: '', hooks: [] },
  ]
  mockStore.content[CH2] = '第二章正文'.repeat(100)
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const p of gen) out.push(p)
  return out
}

beforeEach(() => {
  mockStore.agents = [agent]
  mockStore.volumes = []
  mockStore.chapters = []
  mockStore.content = {}
  mockStore.updates = []
  mockStore.kbWrites = []
  mockStore.kbOutline = ''
  mockStore.syncCalls = []
  mockStore.chatQueue = []
  mockStore.prompts = []
})

describe('ai-outline · buildOutline', () => {
  it('无已配置 Agent：报错并终止', async () => {
    mockStore.agents = []
    const phases = await collect(buildOutline(NOVEL, { scope: 'full' }))
    expect(phases[0].phase).toBe('error')
    expect(phases[0].message).toContain('未找到已配置的 Agent')
    expect(phases).toHaveLength(1)
  })

  it('full + 无章节：生成规划性大纲写入 outline.md', async () => {
    mockStore.chatQueue = ['# 全书大纲\n\n## 第1卷《开局》\n卷纲：主角崛起']
    const phases = await collect(buildOutline(NOVEL, { scope: 'full' }))
    expect(phases.map((p) => p.phase)).toEqual(['prepare', 'llm', 'write', 'done'])
    expect(mockStore.kbWrites).toHaveLength(1)
    expect(mockStore.kbWrites[0]).toMatchObject({ file: 'outline.md', origin: 'ai-build-outline' })
    expect(mockStore.kbWrites[0].content).toContain('## 第1卷《开局》')
    expect(mockStore.updates).toHaveLength(0)
  })

  it('full + 有章节：按顺序映射卷纲/章纲/细纲并 syncOutline', async () => {
    seedOneVolumeWithTwoChapters()
    mockStore.chatQueue = [
      JSON.stringify({
        volumes: [
          {
            summary: '卷纲：兄弟反目',
            chapters: [
              { summary: '章摘要一', hooks: ['钩子A1', '钩子A2'] },
              { summary: '章摘要二', hooks: ['钩子B1'] },
            ],
          },
        ],
      }),
    ]
    const phases = await collect(buildOutline(NOVEL, { scope: 'full' }))
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '全文大纲构建完成' })
    expect(mockStore.updates).toEqual([
      { kind: 'volume', id: VOL1, patch: { summary: '卷纲：兄弟反目' } },
      { kind: 'chapter', id: CH1, patch: { summary: '章摘要一', hooks: ['钩子A1', '钩子A2'] } },
      { kind: 'chapter', id: CH2, patch: { summary: '章摘要二', hooks: ['钩子B1'] } },
    ])
    expect(mockStore.syncCalls).toContain('outline')
    // 有摘要的章用摘要，无摘要的章取正文前 2000 字
    expect(mockStore.prompts[0]).toContain('已有摘要一')
    expect(mockStore.prompts[0]).toContain('第二章正文')
  })

  it('full：LLM 输出无法解析为 JSON 时报错且不写入', async () => {
    seedOneVolumeWithTwoChapters()
    mockStore.chatQueue = ['抱歉，我无法输出 JSON']
    const phases = await collect(buildOutline(NOVEL, { scope: 'full' }))
    expect(phases).toEqual([
      { phase: 'prepare', message: '正在收集章节内容…' },
      { phase: 'llm', message: '正在生成全文大纲…' },
      { phase: 'error', message: 'LLM 输出无法解析为 JSON' },
    ])
    expect(mockStore.updates).toHaveLength(0)
  })

  it('volume：卷不存在 / 卷无章节分别报错', async () => {
    const missing = await collect(buildOutline(NOVEL, { scope: 'volume', volumeId: 'nope' }))
    expect(missing[missing.length - 1].message).toBe('未找到该卷')

    mockStore.volumes = [{ id: VOL1, novelId: NOVEL, title: '空卷', order: 1, summary: '' }]
    const empty = await collect(buildOutline(NOVEL, { scope: 'volume', volumeId: VOL1 }))
    expect(empty[empty.length - 1].message).toBe('该卷暂无章节')
  })

  it('volume：成功路径只更新该卷与卷内章节', async () => {
    seedOneVolumeWithTwoChapters()
    mockStore.chatQueue = [
      JSON.stringify({ summary: '新卷纲', chapters: [{ summary: '章一摘要', hooks: [] }] }),
    ]
    const phases = await collect(buildOutline(NOVEL, { scope: 'volume', volumeId: VOL1 }))
    expect(phases[phases.length - 1].phase).toBe('done')
    expect(mockStore.updates).toEqual([
      { kind: 'volume', id: VOL1, patch: { summary: '新卷纲' } },
      // 卷级大纲的 chapters 数组只映射到该卷已有章节，多余的忽略
      { kind: 'chapter', id: CH1, patch: { summary: '章一摘要', hooks: [] } },
    ])
  })

  it('chapter：正文为空报错；正常时写回摘要+细纲', async () => {
    mockStore.chapters = [{ id: CH1, volumeId: VOL1, title: '第一章', order: 1 }]
    const empty = await collect(buildOutline(NOVEL, { scope: 'chapter', chapterId: CH1 }))
    expect(empty[empty.length - 1].message).toBe('该章正文为空')

    mockStore.content[CH1] = '第一章正文内容'
    mockStore.chatQueue = [JSON.stringify({ summary: '摘要', hooks: ['h1', 2] })]
    const ok = await collect(buildOutline(NOVEL, { scope: 'chapter', chapterId: CH1 }))
    expect(ok[ok.length - 1]).toMatchObject({ phase: 'done', message: '章大纲构建完成' })
    expect(mockStore.updates).toEqual([
      { kind: 'chapter', id: CH1, patch: { summary: '摘要', hooks: ['h1', '2'] } },
    ])
  })

  it('full + 已 abort：在 llm 阶段静默终止，不写任何内容', async () => {
    seedOneVolumeWithTwoChapters()
    const controller = new AbortController()
    controller.abort()
    const phases = await collect(buildOutline(NOVEL, { scope: 'full', signal: controller.signal }))
    expect(phases.map((p) => p.phase)).toEqual(['prepare', 'llm'])
    expect(mockStore.updates).toHaveLength(0)
    expect(mockStore.kbWrites).toHaveLength(0)
  })
})

describe('ai-outline · refineOutline', () => {
  it('无现有全文大纲：提示先构建', async () => {
    const phases = await collect(refineOutline(NOVEL, { scope: 'full' }))
    expect(phases[phases.length - 1].message).toBe('暂无全文大纲，请先构建大纲')
  })

  it('full：润色结果覆写 outline.md（origin=ai-refine-outline）', async () => {
    mockStore.kbOutline = '# 旧大纲'
    mockStore.chatQueue = ['# 新大纲\n更完整']
    const phases = await collect(refineOutline(NOVEL, { scope: 'full' }))
    expect(phases.map((p) => p.phase)).toEqual(['prepare', 'llm', 'write', 'done'])
    expect(mockStore.kbWrites[0]).toMatchObject({ file: 'outline.md', origin: 'ai-refine-outline', content: '# 新大纲\n更完整' })
  })

  it('volume：JSON 无 summary 时不更新但正常结束', async () => {
    seedOneVolumeWithTwoChapters()
    mockStore.chatQueue = [JSON.stringify({ other: '字段' })]
    const phases = await collect(refineOutline(NOVEL, { scope: 'volume', volumeId: VOL1 }))
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '卷大纲完善完成' })
    expect(mockStore.updates).toHaveLength(0)
  })

  it('chapter：携带参考卷纲/章纲时 prompt 包含对应片段，写回摘要+细纲', async () => {
    seedOneVolumeWithTwoChapters()
    mockStore.chapters[0].hooks = ['已有细纲']
    mockStore.chapters[1].summary = '第二章已有摘要'
    mockStore.kbOutline = '# 全书大纲'
    mockStore.chatQueue = [JSON.stringify({ summary: '完善摘要', hooks: ['新钩子'] })]
    const phases = await collect(
      refineOutline(NOVEL, {
        scope: 'chapter',
        chapterId: CH1,
        refVolumeRange: { start: 1, end: 1 },
        refChapterRange: { start: 2, end: 2 },
      }),
    )
    expect(phases[phases.length - 1].message).toBe('章大纲完善完成')
    const prompt = mockStore.prompts[0]
    expect(prompt).toContain('# 全书大纲')
    expect(prompt).toContain('第二章已有摘要')
    expect(prompt).toContain('参考章纲')
    expect(prompt).toContain('参考卷纲')
    expect(mockStore.updates).toEqual([
      { kind: 'chapter', id: CH1, patch: { summary: '完善摘要', hooks: ['新钩子'] } },
    ])
  })
})
