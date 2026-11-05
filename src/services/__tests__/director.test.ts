import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig, DirectorTask, SubTask } from '@shared/types'
import {
  buildDirectorPlan,
  topoLayers,
  runDirector,
  createDirectorTask,
  resumeDirector,
} from '../director-service'

// ===== 内存检查点存储（供 tracking-service mock 使用，变量名以 mock 开头以便 vi.mock 引用）=====
const mockCheckpointStore: any[] = []

vi.mock('../tracking-service', () => ({
  saveCheckpoint: vi.fn(async (novelId: string, cp: any) => {
    const i = mockCheckpointStore.findIndex((c) => c.id === cp.id)
    const rec = { ...cp, novelId }
    if (i >= 0) mockCheckpointStore[i] = rec
    else mockCheckpointStore.push(rec)
    return mockCheckpointStore.filter((c) => c.novelId === novelId)
  }),
  loadCheckpoints: vi.fn(async (novelId: string) =>
    mockCheckpointStore.filter((c) => c.novelId === novelId)
  ),
  loadResumePoint: vi.fn(async () => []),
  saveLedgerEntry: vi.fn(async () => []),
  commitChapter: vi.fn(async () => ({})),
  generateStateCard: vi.fn(async () => ({})),
  loadLedger: vi.fn(async () => []),
}))

// 注意：director-service.ts:10 导入的是 './agent-service'，而 llm-service 只导出
// streamChat / chat（并无 agentChat）。此前 mock '../llm-service' 完全未生效，
// 导致真实 agent-service → context-assembler → data-service 链路被执行，
// 在 jsdom 下 window.electronAPI.db 不存在而报错。此处改为 mock 真正的依赖。
vi.mock('../agent-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-service')>()
  return {
    ...actual,
    agentChat: vi.fn(async function* (_agent: any, _msg: string, _opts: any, _signal?: any) {
      yield { delta: 'x', content: 'MOCK_OUTPUT', done: false }
      yield { delta: '', content: '', done: true }
    }),
  }
})

vi.mock('../quality-service', () => ({
  runQualityGate: vi.fn(async () => ({
    score: 92,
    passed: true,
    deslopTag: true,
    aiPatternHits: 0,
    degenerationHits: 0,
    report: 'mock passed',
    checkedAt: new Date().toISOString(),
  })),
}))

vi.mock('../skill-service', () => ({
  loadSkillForAgent: vi.fn(() => ''),
  getSkillMd: vi.fn(() => ''),
  getSkillFile: vi.fn(() => ''),
}))

vi.mock('../rag-service', () => ({
  search: vi.fn(() => []),
  buildContextString: vi.fn(() => ''),
}))

const agents: AgentConfig[] = (
  ['architect', 'writer', 'polisher', 'checker', 'runtime', 'director', 'consistency', 'planner'] as const
).map((role) => ({
  role,
  name: role,
  systemPrompt: 'sys',
  apiKeyEncrypted: 'k',
  provider: 'openai',
  model: 'gpt',
}) as unknown as AgentConfig)

const NOVEL = 'test-novel-1'
const options = { novelId: NOVEL, previousMessages: [] as { role: string; content: string }[] }

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const p of gen) out.push(p)
  return out
}

beforeEach(() => {
  mockCheckpointStore.length = 0
})

describe('P2 导演式编排 - 意图拆解', () => {
  it('默认 L2 计划包含 5 个标准子任务（setup→outline→golden→chapters→review）', () => {
    const plan = buildDirectorPlan('一个废柴逆袭的玄幻故事')
    expect(plan.map((s) => s.id)).toEqual(['setup', 'outline', 'golden', 'chapters', 'review'])
  })

  it('L1 全程主导：所有子任务需审批（autoApprove=false）', () => {
    const plan = buildDirectorPlan('都市神医', 'L1')
    expect(plan.every((s) => s.autoApprove === false)).toBe(true)
  })

  it('L2/L3 关键节点（大纲定稿/黄金三章/卷末）需审批，立项可自动', () => {
    const plan = buildDirectorPlan('悬疑本格', 'L2')
    const writerTasks = plan.filter((s) => s.agentRole === 'writer')
    expect(writerTasks.every((s) => s.autoApprove === false)).toBe(true)
    const setup = plan.find((s) => s.id === 'setup')!
    expect(setup.autoApprove).toBe(true)
  })

  it('子任务依赖关系正确', () => {
    const plan = buildDirectorPlan('科幻末世')
    expect(plan[1].dependsOn).toContain('setup')
    expect(plan[2].dependsOn).toContain('outline')
  })
})

describe('P6 拓扑分层并发调度 (topoLayers)', () => {
  it('默认线性计划：每个子任务独占一层（共 5 层，顺序正确）', () => {
    const task = createDirectorTask(NOVEL, '玄幻', 'L4')
    const layers = topoLayers(task)
    expect(layers).toHaveLength(5)
    expect(layers.map((l) => l[0].id)).toEqual(['setup', 'outline', 'golden', 'chapters', 'review'])
    expect(layers.every((l) => l.length === 1)).toBe(true)
  })

  it('存在无依赖冲突的并行分支时，同层并发归组', () => {
    const setup: SubTask = { id: 'setup', agentRole: 'architect', skillRefs: [], status: 'pending', input: '立项', autoApprove: true, dependsOn: [] }
    const outline: SubTask = { id: 'outline', agentRole: 'planner', skillRefs: [], status: 'pending', input: '大纲', autoApprove: true, dependsOn: ['setup'] }
    const extra: SubTask = { id: 'extra', agentRole: 'checker', skillRefs: [], status: 'pending', input: '预检', autoApprove: true, dependsOn: ['setup'] }
    const golden: SubTask = { id: 'golden', agentRole: 'writer', skillRefs: [], status: 'pending', input: '黄金', autoApprove: true, dependsOn: ['outline'] }
    const task: DirectorTask = {
      id: 't', novelId: NOVEL, intent: 'x', level: 'L4',
      decomposed: [setup, outline, extra, golden],
      status: 'pending', createdAt: '', updatedAt: '',
    }
    const layers = topoLayers(task)
    expect(layers[0].map((s) => s.id)).toEqual(['setup'])
    expect(layers[1].map((s) => s.id).sort()).toEqual(['extra', 'outline'])
    expect(layers[2].map((s) => s.id)).toEqual(['golden'])
  })
})

describe('P6 审批节点分级 (approvalRequest.reason)', () => {
  it('L1：首个子任务即暂停审批，原因含 L1 文案', async () => {
    const task = createDirectorTask(NOVEL, '玄幻', 'L1')
    const progresses = await collect(runDirector(task, agents, NOVEL, options))
    const first = progresses[0]
    expect(first.status).toBe('awaiting-approval')
    expect(first.approvalRequest?.reason).toContain('L1')
  })

  it('L4：自动跑完 setup→outline→golden→chapters，仅在卷末 review（consistency）暂停，原因含 L4 文案', async () => {
    const task = createDirectorTask(NOVEL, '玄幻', 'L4')
    const progresses = await collect(runDirector(task, agents, NOVEL, options))
    const completed = progresses.filter((p) => p.status === 'completed')
    // setup/outline/golden/chapters 四个阶段自动完成
    expect(completed.map((p) => p.agentRole)).toEqual(['director', 'planner', 'writer', 'writer'])
    const approval = progresses.find((p) => p.status === 'awaiting-approval')
    expect(approval).toBeTruthy()
    expect(approval.approvalRequest?.reason).toContain('L4')
    // L4 仅卷末（review，consistency 角色）需审批
    expect(approval.agentRole).toBe('consistency')
  })
})

describe('P6 完整自动产出（全 autoApprove）', () => {
  it('所有子任务 autoApprove=true 时，5 个阶段全部 completed 且无 awaiting', async () => {
    const task = createDirectorTask(NOVEL, '玄幻', 'L4')
    task.decomposed.forEach((s) => (s.autoApprove = true))
    const progresses = await collect(runDirector(task, agents, NOVEL, options))
    const completed = progresses.filter((p) => p.status === 'completed')
    expect(completed).toHaveLength(5)
    expect(progresses.some((p) => p.status === 'awaiting-approval')).toBe(false)
    // 5 条 checkpoint 已落库
    expect(mockCheckpointStore.filter((c) => c.novelId === NOVEL)).toHaveLength(5)
  })
})

describe('P6 断点续跑 (resumeDirector + SQLite 回灌)', () => {
  it('L4 首次跑到卷末 review 暂停后，批准 review 并续跑可完整完成', async () => {
    const task = createDirectorTask(NOVEL, '玄幻', 'L4')
    // 第一次：自动跑完 setup→outline→golden→chapters，于卷末 review 暂停
    const first = await collect(runDirector(task, agents, NOVEL, options))
    const reviewPause = first.find((p) => p.status === 'awaiting-approval' && p.agentRole === 'consistency')
    expect(reviewPause).toBeTruthy()
    expect(reviewPause.approvalRequest?.reason).toContain('L4')

    // 作者批准 review：标记 autoApprove=true 后续跑
    const review = task.decomposed.find((s) => s.id === 'review')!
    review.autoApprove = true
    const second = await collect(resumeDirector(task, agents, NOVEL, options))

    // setup..chapters 已在首次完成并被跳过，仅 review 续跑完成，不再有 awaiting
    const reviewDone = second.find((p) => p.agentRole === 'consistency' && p.status === 'completed')
    expect(reviewDone).toBeTruthy()
    expect(second.some((p) => p.status === 'awaiting-approval')).toBe(false)
  })
})
