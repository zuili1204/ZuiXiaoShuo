import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig } from '@shared/types'

const state = vi.hoisted(() => ({
  outputs: [] as string[],
  calls: [] as { agent: AgentConfig; userMessage: string; options: any }[],
}))

vi.mock('../agent-service', () => ({
  agentChat: vi.fn(async function* (agent: AgentConfig, userMessage: string, options: any) {
    state.calls.push({ agent, userMessage, options })
    const out = state.outputs.shift() ?? ''
    if (out) yield { content: out, done: false }
  }),
}))

vi.mock('../log-service', () => ({
  ActionLog: { agent: vi.fn() },
}))

import {
  PlanProposalError,
  callPlanLLM,
  extractPlanJson,
  parsePlanEnvelope,
} from '../planning-llm'

const agent: AgentConfig = {
  id: 'a1',
  name: '架构师',
  role: 'architect',
  provider: 'openai',
  model: 'gpt-x',
  apiKeyEncrypted: '',
  temperature: 0.7,
  maxTokens: 4000,
  systemPrompt: '',
  skillRefs: ['story-outline-gen'],
  isActive: true,
}

const seedPayload = {
  titles: ['雾港来信'],
  genre: '都市悬疑',
  premise: '退役法医收到自己的死亡证明',
  synopsis: '林岸被迫重查十年前旧案。',
  coreConflict: '林岸想查真相，但警队有人阻止',
  characters: [
    { name: '林岸', role: '主角', desire: '查清旧案', obstacle: '被停职', flaw: '固执' },
    { name: '周砚', role: '配角', desire: '升职', obstacle: '旧案牵涉上司' },
    { name: '沈雪', role: '反派', desire: '掩盖真相', obstacle: '林岸逼近' },
  ],
  worldAnchors: ['雾港多雾', '法医中心', '旧案卷宗'],
  sellingPoints: ['倒计时', '法医细节', '旧案反转'],
  tone: '冷峻',
  audience: '悬疑读者',
}

function envelope(payload: unknown, stage = 'seed', baseRevision = 'rev-1') {
  return JSON.stringify({ stage, baseRevision, payload, warnings: ['【假设】默认单主角'] })
}

beforeEach(() => {
  state.outputs = []
  state.calls = []
  ;(window as any).electronAPI = {
    plan: {
      validate: vi.fn(async () => ({ ok: true, errors: [] })),
    },
  }
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('planning-llm · 信封解析', () => {
  it('提取首个 JSON 对象', () => {
    expect(extractPlanJson('前言 {"a":1} 后记 {"b":2}')).toBe('{"a":1} 后记 {"b":2}')
  })

  it('stage / baseRevision / payload / warnings 合法时通过', () => {
    const r = parsePlanEnvelope(envelope({ a: 1 }), 'seed', 'rev-1')
    expect(r.errors).toEqual([])
    expect(r.envelope?.payload).toEqual({ a: 1 })
    expect(r.envelope?.warnings).toEqual(['【假设】默认单主角'])
  })

  it('stage 或 baseRevision 不一致时报错', () => {
    expect(parsePlanEnvelope(envelope({}, 'master'), 'seed', 'rev-1').errors.join()).toContain('stage 应为')
    expect(parsePlanEnvelope(envelope({}, 'seed', 'rev-2'), 'seed', 'rev-1').errors.join()).toContain('baseRevision')
  })

  it('缺 payload 或 warnings 非数组时报错', () => {
    const r = parsePlanEnvelope('{"stage":"seed","baseRevision":"rev-1","warnings":[]}', 'seed', 'rev-1')
    expect(r.envelope).toBeNull()
    expect(r.errors.join()).toContain('payload')
  })
})

describe('planning-llm · callPlanLLM', () => {
  it('注入阶段技能+参考+契约，并传 skillPromptOverride 防止自动匹配', async () => {
    state.outputs = [envelope(seedPayload)]
    const res = await callPlanLLM(agent, 'n1', 'seed', '补全立项', { baseRevision: 'rev-1' })

    expect(res.payload).toMatchObject({ genre: '都市悬疑' })
    expect(res.route.primarySkill).toBe('story-plan-workspace/a1_seed')
    expect(res.warnings).toEqual(['【假设】默认单主角'])
    expect(res.repaired).toBe(false)

    const call = state.calls[0]
    expect(call.options.skillPromptOverride).toContain('A1 · 立项书')
    expect(call.options.skillPromptOverride).toContain('参考文件：story-plan-workspace/references/seed-card.md')
    expect(call.options.skillPromptOverride).toContain('契约参考：story-plan-workspace/references/proposal-contracts.md')
    expect(call.options.skillPromptOverride).toContain('SeedProposal')
    expect(call.options.skillPromptOverride).not.toContain('story-outline-gen')
    expect(call.userMessage).toContain('补全立项')
    expect(call.userMessage).toContain('"stage": "seed"')
    expect(call.userMessage).toContain('"baseRevision": "rev-1"')
    // 写入 agent 的技能引用是路由声明，不是原 agent 的 story-outline-gen
    expect(call.agent.skillRefs).toEqual(['story-plan-workspace/a1_seed', 'story-idea-incubate/core'])
  })

  it('主进程校验失败时修复一次，修复后通过', async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errors: ['payload.titles: 需要 1-3 个非空书名'] })
      .mockResolvedValueOnce({ ok: true, errors: [] })
    ;(window as any).electronAPI.plan.validate = validate

    state.outputs = [
      envelope({ ...seedPayload, titles: [] }),
      envelope(seedPayload),
    ]
    const res = await callPlanLLM(agent, 'n1', 'seed', '补全立项', { baseRevision: 'rev-1' })

    expect(res.repaired).toBe(true)
    expect(validate).toHaveBeenCalledTimes(2)
    expect(state.calls).toHaveLength(2)
    expect(state.calls[1].userMessage).toContain('校验错误')
    expect(state.calls[1].userMessage).toContain('payload.titles')
    expect(state.calls[1].options.skillPromptOverride).toContain('A1 · 立项书')
  })

  it('修复后仍失败则抛 PlanProposalError，不返回半成品', async () => {
    ;(window as any).electronAPI.plan.validate = vi.fn(async () => ({
      ok: false,
      errors: ['payload.characters: 需要 3-6 个角色'],
    }))
    state.outputs = [envelope(seedPayload), envelope(seedPayload)]

    await expect(
      callPlanLLM(agent, 'n1', 'seed', '补全立项', { baseRevision: 'rev-1' }),
    ).rejects.toBeInstanceOf(PlanProposalError)
    expect(state.calls).toHaveLength(2)
  })

  it('非 JSON 输出会触发一次修复；maxRepair=0 时直接失败', async () => {
    state.outputs = ['我不会输出 JSON']
    await expect(
      callPlanLLM(agent, 'n1', 'seed', '补全立项', { baseRevision: 'rev-1', maxRepair: 0 }),
    ).rejects.toBeInstanceOf(PlanProposalError)
    expect(state.calls).toHaveLength(1)
  })

  it('没有主进程校验时降级为信封校验并标记 skipped', async () => {
    delete (window as any).electronAPI
    state.outputs = [envelope(seedPayload)]
    const res = await callPlanLLM(agent, 'n1', 'seed', '补全立项', { baseRevision: 'rev-1' })
    expect(res.validation.skipped).toBe(true)
    expect(res.validation.ok).toBe(true)
  })

  it('已写章 id 会透传给主进程校验', async () => {
    const validate = vi.fn(async () => ({ ok: true, errors: [] }))
    ;(window as any).electronAPI.plan.validate = validate
    state.outputs = [envelope({ volumeIndex: 0, chapters: [] }, 'volume-chapters')]
    await callPlanLLM(agent, 'n1', 'volume-chapters', '生成章纲', {
      baseRevision: 'rev-1',
      writtenIds: ['ch-1', 'ch-2'],
    })
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'volume-chapters', writtenIds: ['ch-1', 'ch-2'] }),
    )
  })
})
