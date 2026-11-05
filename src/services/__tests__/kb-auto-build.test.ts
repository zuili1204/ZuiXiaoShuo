import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig } from '@shared/types'
import { autoBuildKnowledgeBase, ensureStoryMemory } from '../kb-auto-build'

// ===== mock 状态（vi.mock 工厂仅在回调期读取，避免 TDZ）=====
const mockStore = {
  agents: [] as any[],
  volumes: [] as any[],
  chapters: [] as any[],
  content: {} as Record<string, string>,
  updates: [] as { id: string; patch: any }[],
  briefs: [] as any[],
  novelSummary: null as any,
  initCalls: [] as string[],
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
  },
  chapterService: {
    getByVolumeId: vi.fn(async (vid: string) => mockStore.chapters.filter((c) => c.volumeId === vid)),
    loadContent: vi.fn(async (id: string) => mockStore.content[id] ?? ''),
    update: vi.fn(async (id: string, patch: any) => {
      mockStore.updates.push({ id, patch })
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
    initKnowledgeBaseForExistingNovel: vi.fn(async (n: string) => {
      mockStore.initCalls.push(n)
    }),
    applyChapterBrief: vi.fn(async (_n: string, _ch: string, brief: any) => {
      mockStore.briefs.push(brief)
    }),
    applyNovelSummary: vi.fn(async (_n: string, s: any) => {
      mockStore.novelSummary = s
    }),
    syncCharacters: vi.fn(async () => {
      mockStore.syncCalls.push('characters')
    }),
    syncWorldviews: vi.fn(async () => {
      mockStore.syncCalls.push('worldviews')
    }),
    syncOutline: vi.fn(async () => {
      mockStore.syncCalls.push('outline')
    }),
    syncForeshadowings: vi.fn(async () => {
      mockStore.syncCalls.push('foreshadowings')
    }),
  },
}))

const writerAgent: AgentConfig = {
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

const FULL_BRIEF = JSON.stringify({
  summary: '陈默发现旧笔记会自动续写',
  keyEvents: ['发现笔记', '首次续写'],
  charactersInvolved: ['陈默'],
  newForeshadowings: ['笔记的来历'],
  resolvedForeshadowings: [],
  nextChapterHook: '笔记写下他的名字',
})

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const p of gen) out.push(p)
  return out
}

beforeEach(() => {
  mockStore.agents = [writerAgent]
  mockStore.volumes = [{ id: VOL1, novelId: NOVEL, title: '第一卷', order: 1 }]
  mockStore.chapters = [{ id: CH1, volumeId: VOL1, title: '第一章', order: 1 }]
  mockStore.content = { [CH1]: '第一章正文内容' }
  mockStore.updates = []
  mockStore.briefs = []
  mockStore.novelSummary = null
  mockStore.initCalls = []
  mockStore.syncCalls = []
  mockStore.chatQueue = []
  mockStore.prompts = []
})

describe('kb-auto-build · autoBuildKnowledgeBase', () => {
  it('无已配置 Agent：报错并终止', async () => {
    mockStore.agents = []
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases[0]).toMatchObject({ phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' })
    expect(phases).toHaveLength(1)
  })

  it('无章节：报错「该小说暂无章节」', async () => {
    mockStore.chapters = []
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases[phases.length - 1].message).toBe('该小说暂无章节')
  })

  it('先初始化知识库骨架，再逐章提取', async () => {
    mockStore.chatQueue = [FULL_BRIEF]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(mockStore.initCalls).toEqual([NOVEL])
    expect(phases[0]).toMatchObject({ phase: 'chapter', index: 0, total: 1, chapterId: CH1, title: '第一章' })
  })

  it('正常路径：brief 归一化写入 KB，summary 同步到 chapter，全书概要补全卷 ID', async () => {
    mockStore.chatQueue = [
      FULL_BRIEF,
      JSON.stringify({
        novel_summary: '一个关于会自动续写笔记的悬疑故事',
        volume_summaries: [{ title: '第一卷', theme: '悬疑', mainPlot: '追查笔记来历', endingHook: '笔记反噬' }],
        current_position: { volume: 1, chapter: 1, title: '第一章' },
        next_direction: '揭示笔记主人身份',
      }),
    ]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', index: 1, total: 1, message: '完成：共处理 1/1 章' })
    expect(mockStore.briefs).toEqual([
      {
        summary: '陈默发现旧笔记会自动续写',
        keyEvents: ['发现笔记', '首次续写'],
        charactersInvolved: ['陈默'],
        newForeshadowings: ['笔记的来历'],
        resolvedForeshadowings: [],
        nextChapterHook: '笔记写下他的名字',
      },
    ])
    expect(mockStore.updates).toEqual([{ id: CH1, patch: { summary: '陈默发现旧笔记会自动续写' } }])
    expect(mockStore.novelSummary).toMatchObject({
      novel_summary: '一个关于会自动续写笔记的悬疑故事',
    })
    // 卷 ID 由 LLM 不可知 → 按顺序补全为真实卷 ID
    expect(mockStore.novelSummary.volume_summaries[0].volumeId).toBe(VOL1)
    expect(mockStore.syncCalls).toEqual(['characters', 'worldviews', 'outline', 'foreshadowings'])
    // 单章 prompt 携带卷/章上下文
    expect(mockStore.prompts[0]).toContain('第1章 第一章')
  })

  it('多章处理：LLM 优先 writer 角色，逐章出进度', async () => {
    mockStore.chapters.push({ id: CH2, volumeId: VOL1, title: '第二章', order: 2 })
    mockStore.content[CH2] = '第二章正文内容'
    mockStore.agents = [{ ...writerAgent, role: 'architect' }, writerAgent]
    mockStore.chatQueue = [
      JSON.stringify({ summary: '第一章摘要' }),
      JSON.stringify({ summary: '第二章摘要', keyEvents: '不是数组', charactersInvolved: ['陈默'] }),
      JSON.stringify({ novel_summary: '全书概要' }),
    ]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    const done = phases[phases.length - 1]
    expect(done).toMatchObject({ phase: 'done', message: '完成：共处理 2/2 章' })
    // 非数组字段归一化为空数组，不抛错
    expect(mockStore.briefs[1]).toMatchObject({ summary: '第二章摘要', keyEvents: [], charactersInvolved: ['陈默'] })
    expect(mockStore.updates).toHaveLength(2)
  })

  it('正文为空的章节跳过且不计入处理数', async () => {
    mockStore.content[CH1] = ''
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases.some((p) => p.message === '正文为空，跳过')).toBe(true)
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '完成：共处理 0/1 章' })
    expect(mockStore.briefs).toHaveLength(0)
    expect(mockStore.syncCalls).toHaveLength(0) // 无 chapterSummaries → 不进总结阶段
  })

  it('LLM 返回非 JSON 文本：降级取前 200 字作摘要', async () => {
    mockStore.chatQueue = ['这不是JSON，只是普通文本的摘要描述，应该被降级处理。'.repeat(10)]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases.some((p) => p.message === '完成（降级）')).toBe(true)
    expect(mockStore.briefs[0].summary).toContain('这不是JSON')
    expect(mockStore.briefs[0].keyEvents).toEqual([])
    expect(mockStore.updates[0].patch.summary).toContain('这不是JSON')
  })

  it('LLM 两次空响应：跳过该章（含 2 秒重试等待）', async () => {
    mockStore.chatQueue = ['', '']
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases[phases.length - 1]).toMatchObject({ phase: 'done', message: '完成：共处理 0/1 章' })
    expect(phases.some((p) => p.message === 'LLM 返回空内容，跳过')).toBe(true)
    // 两次尝试 = 两次 prompt
    expect(mockStore.prompts).toHaveLength(2)
  })

  it('agentChat 抛 AbortError：静默终止，不产生 error/done', async () => {
    mockStore.chatQueue = [Object.assign(new Error('aborted'), { name: 'AbortError' })]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL))
    expect(phases).toHaveLength(1) // 仅首个 chapter 进度
    expect(phases[0].phase).toBe('chapter')
  })

  it('已 abort 的 signal：在章节处理中静默终止', async () => {
    const controller = new AbortController()
    controller.abort()
    const phases = await collect(autoBuildKnowledgeBase(NOVEL, controller.signal))
    expect(phases.map((p) => p.phase)).toEqual(['chapter'])
    expect(mockStore.briefs).toHaveLength(0)
  })
})

describe('kb-auto-build · ensureStoryMemory（续写前剧情记忆保障）', () => {
  it('无缺失摘要：静默通过，不产生任何 LLM 调用与知识库写入', async () => {
    mockStore.chapters = [
      { id: CH1, volumeId: VOL1, title: '第一章', order: 1, wordCount: 2000, summary: '已有摘要' },
    ]
    const phases = await collect(ensureStoryMemory(NOVEL))
    expect(phases).toHaveLength(1)
    expect(phases[0].phase).toBe('done')
    expect(phases[0].message).toContain('无需构建')
    expect(mockStore.prompts).toHaveLength(0)
    expect(mockStore.initCalls).toHaveLength(0)
    expect(mockStore.briefs).toHaveLength(0)
  })

  it('正文为空的草稿章不算缺失', async () => {
    mockStore.chapters = [
      { id: CH1, volumeId: VOL1, title: '第31章（待生成）', order: 31, wordCount: 0, summary: '' },
    ]
    const phases = await collect(ensureStoryMemory(NOVEL))
    expect(phases[0].message).toContain('无需构建')
    expect(mockStore.prompts).toHaveLength(0)
  })

  it('检测到缺失：自动构建并回写章节摘要', async () => {
    mockStore.chapters = [
      { id: CH1, volumeId: VOL1, title: '第一章', order: 1, wordCount: 2000, summary: '' },
    ]
    mockStore.chatQueue = [FULL_BRIEF]
    const phases = await collect(ensureStoryMemory(NOVEL))
    expect(phases[0].message).toContain('1 章缺少剧情摘要')
    expect(mockStore.updates.some((u) => u.id === CH1 && u.patch.summary === '陈默发现旧笔记会自动续写')).toBe(true)
    expect(phases[phases.length - 1].phase).toBe('done')
  })
})

describe('kb-auto-build · onlyMissing 选项', () => {
  it('已有摘要的章节跳过提取，但摘要仍计入全书总结', async () => {
    mockStore.chapters = [
      { id: CH1, volumeId: VOL1, title: '第一章', order: 1, wordCount: 2000, summary: '已有摘要A' },
      { id: CH2, volumeId: VOL1, title: '第二章', order: 2, wordCount: 2000, summary: '' },
    ]
    mockStore.content = { [CH2]: '第二章正文' }
    mockStore.chatQueue = [
      FULL_BRIEF,
      JSON.stringify({ novel_summary: '全书概要', volume_summaries: [] }),
    ]
    const phases = await collect(autoBuildKnowledgeBase(NOVEL, undefined, { onlyMissing: true }))
    // 第一章未被重新提取（prompt 中不出现其正文）
    expect(mockStore.prompts.some((p) => p.includes('第一章正文'))).toBe(false)
    // 第二章摘要已回写
    expect(mockStore.updates.some((u) => u.id === CH2 && u.patch.summary === '陈默发现旧笔记会自动续写')).toBe(true)
    // 全书总结 prompt 汇总了两章摘要（含未重新提取的已有摘要A）
    const summaryPrompt = mockStore.prompts.find((p) => p.includes('各章摘要'))
    expect(summaryPrompt).toContain('已有摘要A')
    expect(phases.filter((p) => p.message === '已有摘要，跳过')).toHaveLength(1)
  })
})
