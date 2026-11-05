import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '@shared/types'
import { extractCharacters, craftCharacter } from '../ai-character'

// ===== mock 状态（vi.mock 工厂仅在回调期读取，避免 TDZ）=====
const mockStore = {
  agents: [] as any[],
  volumes: [] as any[],
  chapters: [] as any[],
  characters: [] as any[],
  content: {} as Record<string, string>,
  creates: [] as any[],
  syncCalls: [] as string[],
  ragCalls: 0,
  chatQueue: [] as (string | Error)[],
  prompts: [] as string[],
}

vi.mock('../data-service', () => ({
  agentConfigService: {
    getAll: vi.fn(async () => mockStore.agents),
  },
  volumeService: {
    getByNovelId: vi.fn(async () => mockStore.volumes),
  },
  chapterService: {
    getByVolumeId: vi.fn(async (vid: string) => mockStore.chapters.filter((c) => c.volumeId === vid)),
    loadContent: vi.fn(async (id: string) => mockStore.content[id] ?? ''),
  },
  characterService: {
    getByNovelId: vi.fn(async () => mockStore.characters),
    create: vi.fn(async (c: any) => {
      mockStore.creates.push(c)
      return c
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
    syncCharacters: vi.fn(async () => {
      mockStore.syncCalls.push('characters')
    }),
  },
}))

vi.mock('../rag-service', () => ({
  indexNovelAssets: vi.fn(async () => {
    mockStore.ragCalls += 1
  }),
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

function seedOneChapter(content = '第一章正文：陈默走进了旧书店。') {
  mockStore.volumes = [{ id: VOL1, novelId: NOVEL, title: '第一卷', order: 1 }]
  mockStore.chapters = [{ id: CH1, volumeId: VOL1, title: '第一章', order: 1 }]
  mockStore.content[CH1] = content
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
  mockStore.characters = []
  mockStore.content = {}
  mockStore.creates = []
  mockStore.syncCalls = []
  mockStore.ragCalls = 0
  mockStore.chatQueue = []
  mockStore.prompts = []
})

describe('ai-character · extractCharacters', () => {
  it('无已配置 Agent：报错并终止', async () => {
    mockStore.agents = []
    const phases = await collect(extractCharacters(NOVEL))
    expect(phases[0]).toMatchObject({ phase: 'error' })
    expect(phases).toHaveLength(1)
  })

  it('无章节：报错「该小说暂无章节」', async () => {
    const phases = await collect(extractCharacters(NOVEL))
    expect(phases[phases.length - 1].message).toBe('该小说暂无章节，无法提取角色')
  })

  it('正常提取：跨章按姓名去重，跳过已有角色，写入后同步 KB 与 RAG', async () => {
    seedOneChapter()
    mockStore.volumes[0] = mockStore.volumes[0]
    // 第二卷第二章（验证多章去重）
    mockStore.volumes.push({ id: 'vol-2', novelId: NOVEL, title: '第二卷', order: 2 })
    mockStore.chapters.push({ id: 'ch-2', volumeId: 'vol-2', title: '第二章', order: 1 })
    mockStore.content['ch-2'] = '第二章正文：陈默再次出现，遇到了新角色林晚。'
    mockStore.characters = [{ id: 'exist-1', novelId: NOVEL, name: '陈默' }]

    mockStore.chatQueue = [
      // 第一章：陈默（已存在）+ 苏晴（新）
      JSON.stringify({
        characters: [
          { name: '陈默', role: 'protagonist', gender: 'male' },
          { name: '苏晴', role: 'supporting', gender: 'female', personality: '冷静' },
        ],
      }),
      // 第二章：陈默（重复）+ 林晚（新）
      JSON.stringify({
        characters: [
          { name: '陈默' },
          { name: '林晚', role: 'antagonist', gender: 'female' },
        ],
      }),
    ]

    const phases = await collect(extractCharacters(NOVEL))
    const last = phases[phases.length - 1]
    expect(last.phase).toBe('done')
    expect(last.message).toContain('新增 2 个角色')
    expect(mockStore.creates.map((c) => c.name).sort()).toEqual(['林晚', '苏晴'])
    expect(mockStore.creates.every((c) => c.novelId === NOVEL && c.id)).toBe(true)
    expect(mockStore.creates.find((c) => c.name === '苏晴')).toMatchObject({ role: 'supporting', personality: '冷静' })
    expect(mockStore.syncCalls).toContain('characters')
    expect(mockStore.ragCalls).toBe(1)
    // 章节进度事件
    expect(phases.filter((p) => p.phase === 'chapter' && p.message === '提取 2 个角色')).toHaveLength(2)
  })

  it('正文为空的章节跳过；全部章节无新角色时提示无新增', async () => {
    seedOneChapter('')
    mockStore.characters = []
    const phases = await collect(extractCharacters(NOVEL))
    expect(phases.some((p) => p.phase === 'chapter' && p.message === '正文为空，跳过')).toBe(true)
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '未发现新角色（已有角色均已收录）' })
    expect(mockStore.creates).toHaveLength(0)
  })

  it('LLM 输出非 JSON：该章解析失败跳过，流程不中断', async () => {
    seedOneChapter()
    mockStore.chatQueue = ['这里没有 JSON']
    const phases = await collect(extractCharacters(NOVEL))
    expect(phases.some((p) => p.phase === 'chapter' && p.message === '解析失败，跳过')).toBe(true)
    expect(phases[phases.length - 1].phase).toBe('done')
    expect(mockStore.creates).toHaveLength(0)
  })

  it('已 abort：在章节处理中静默终止', async () => {
    seedOneChapter()
    const controller = new AbortController()
    controller.abort()
    const phases = await collect(extractCharacters(NOVEL, { signal: controller.signal }))
    expect(phases.map((p) => p.phase)).toEqual(['prepare', 'chapter'])
    expect(mockStore.creates).toHaveLength(0)
  })
})

describe('ai-character · craftCharacter', () => {
  it('正常构筑：LLM 字段缺失时回退到 options 的 role/gender', async () => {
    seedOneChapter()
    mockStore.chatQueue = [
      JSON.stringify({ name: '  沈青  ', age: '28', personality: '外冷内热' }),
    ]
    const phases = await collect(
      craftCharacter(NOVEL, { role: 'antagonist', gender: 'female' }),
    )
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '角色构筑完成：沈青' })
    expect(mockStore.creates[0]).toMatchObject({
      name: '沈青',
      role: 'antagonist',
      gender: 'female',
      age: '28',
      personality: '外冷内热',
    })
    expect(mockStore.creates[0].id).toMatch(/^char_/)
    expect(mockStore.syncCalls).toContain('characters')
    expect(mockStore.ragCalls).toBe(1)
  })

  it('prompt 携带性别与定位提示', async () => {
    mockStore.chatQueue = [JSON.stringify({ name: '路人甲' })]
    await collect(craftCharacter(NOVEL, { role: 'supporting', gender: 'male' }))
    expect(mockStore.prompts[0]).toContain('性别限定：男')
    expect(mockStore.prompts[0]).toContain('角色定位：配角')
  })

  it('角色名为空：报错「角色名为空」', async () => {
    mockStore.chatQueue = [JSON.stringify({ name: '   ' })]
    const phases = await collect(craftCharacter(NOVEL))
    expect(phases[phases.length - 1].message).toBe('角色名为空')
    expect(mockStore.creates).toHaveLength(0)
  })

  it('LLM 输出无法解析为 JSON：报错', async () => {
    mockStore.chatQueue = ['不是 JSON']
    const phases = await collect(craftCharacter(NOVEL))
    expect(phases[phases.length - 1].message).toBe('LLM 输出无法解析为 JSON')
  })

  it('无已配置 Agent：报错并终止', async () => {
    mockStore.agents = []
    const phases = await collect(craftCharacter(NOVEL))
    expect(phases[0]).toMatchObject({ phase: 'error', message: '未找到已配置的 Agent' })
  })
})
