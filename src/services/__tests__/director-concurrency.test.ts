import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentConfig, DirectorTask, SubTask } from '@shared/types'
import { runDirector } from '../director-service'

// P2-2 回归：层内真并发 + 进度实时透出。
// v0.8 曾误诊「Promise.all(drainGenerator) 实为串行」——实测并发本就成立（3×200ms 任务 wall≈214ms），
// 真实缺陷是进度整层缓冲后才 yield。本文件固化两个准则：
//   ① 计时准则：3 个无依赖子任务总耗时接近单个耗时（并发，不是 3 倍串行）；
//   ② 流式准则：running 事件按到达顺序立即 yield（前 N 个事件全是 running，
//      而不是旧实现的 per-generator 分组 running,completed,running,completed…）。

vi.mock('../tracking-service', () => ({
  saveCheckpoint: vi.fn(async () => []),
  loadCheckpoints: vi.fn(async () => []),
  loadResumePoint: vi.fn(async () => []),
  saveLedgerEntry: vi.fn(async () => []),
  commitChapter: vi.fn(async () => ({})),
  generateStateCard: vi.fn(async () => ({})),
  loadLedger: vi.fn(async () => []),
}))

const CALL_LOG: { start: number; end: number }[] = []
const T0 = Date.now()
vi.mock('../agent-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-service')>()
  return {
    ...actual,
    agentChat: vi.fn(async function* (_a: any, _m: string, _o: any, _s?: any) {
      const start = Date.now() - T0
      await new Promise((r) => setTimeout(r, 200))
      CALL_LOG.push({ start, end: Date.now() - T0 })
      yield { content: 'OUT', done: false }
      yield { content: '', done: true }
    }),
  }
})

vi.mock('../quality-service', () => ({
  runQualityGate: vi.fn(async () => ({
    score: 90,
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

const agent: AgentConfig = {
  role: 'writer',
  name: 'w',
  systemPrompt: 's',
  apiKeyEncrypted: 'k',
  provider: 'openai',
  model: 'g',
} as unknown as AgentConfig

const NOVEL = 'n1'

function sameLayerTask(ids: string[], opts: { autoApprove?: boolean } = {}): DirectorTask {
  const sub: SubTask[] = ids.map((id) => ({
    id,
    agentRole: 'writer',
    skillRefs: [],
    input: `任务${id}`,
    autoApprove: opts.autoApprove ?? true,
    dependsOn: [],
    status: 'pending' as const,
  }))
  return {
    id: 't1',
    novelId: NOVEL,
    intent: 'x',
    level: 'L4',
    decomposed: sub,
    status: 'pending',
    createdAt: '',
    updatedAt: '',
  }
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = []
  for await (const p of gen) out.push(p)
  return out
}

beforeEach(() => {
  CALL_LOG.length = 0
})

describe('P2-2 director 层内真并发 + 进度实时透出', () => {
  it('计时准则：3 个同层子任务 wall ≈ 单个耗时（<2×200ms），且确实各调用了一次', async () => {
    const task = sameLayerTask(['a', 'b', 'c'])
    const t0 = Date.now()
    const events = await collect(
      runDirector(task, [agent], NOVEL, { novelId: NOVEL, previousMessages: [] }),
    )
    const wall = Date.now() - t0
    expect(CALL_LOG).toHaveLength(3)
    expect(wall).toBeLessThan(400) // 串行 ≈ 600ms+；并发 ≈ 200ms±
    expect(task.status).toBe('completed')
    expect(events.filter((e) => e.status === 'completed')).toHaveLength(3)
  })

  it('流式准则：前 N 个事件全部是 running（到达即 yield，非整层缓冲）', async () => {
    const task = sameLayerTask(['a', 'b', 'c'])
    const events = await collect(
      runDirector(task, [agent], NOVEL, { novelId: NOVEL, previousMessages: [] }),
    )
    const statuses = events.map((e) => e.status)
    expect(statuses.slice(0, 3)).toEqual(['running', 'running', 'running'])
    expect(statuses.slice(3)).toEqual(['completed', 'completed', 'completed'])
  })

  it('屏障语义：层内缺 Agent 的子任务报 error，其余子任务仍跑完，整层收尾后 paused', async () => {
    const task = sameLayerTask(['a', 'b', 'c'])
    // b 用未提供 Agent 的角色 → 该 generator 直接 yield error；a/c 正常执行
    ;(task.decomposed[1] as SubTask).agentRole = 'checker'
    const events = await collect(
      runDirector(task, [agent], NOVEL, { novelId: NOVEL, previousMessages: [] }),
    )
    const err = events.find((e) => e.status === 'error')
    expect(err).toBeDefined()
    expect(err.output).toContain('未找到角色')
    // 屏障：error 前后其余子任务的事件都要出齐（整层收尾，不打断在途 checkpoint）
    expect(events.filter((e) => e.status === 'completed')).toHaveLength(2)
    expect(task.status).toBe('paused')
  })

  it('已 abort 的 signal：直接返回，不产生任何事件', async () => {
    const task = sameLayerTask(['a', 'b'])
    const controller = new AbortController()
    controller.abort()
    const events = await collect(
      runDirector(task, [agent], NOVEL, { novelId: NOVEL, previousMessages: [] }, controller.signal),
    )
    expect(events).toHaveLength(0)
    expect(CALL_LOG).toHaveLength(0)
  })

  it('审批节点：autoApprove=false 的子任务只出 awaiting-approval，后续层不执行', async () => {
    const task = sameLayerTask(['a', 'b'], { autoApprove: false })
    const events = await collect(
      runDirector(task, [agent], NOVEL, { novelId: NOVEL, previousMessages: [] }),
    )
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.status === 'awaiting-approval')).toBe(true)
    expect(events[0].approvalRequest.subtaskId).toBe('a')
    expect(events[1].approvalRequest.reason).toContain('L4 全自动')
    expect(CALL_LOG).toHaveLength(0)
    expect(task.status).toBe('paused')
  })
})
