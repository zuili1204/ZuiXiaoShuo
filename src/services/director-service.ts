import type {
  AgentConfig,
  SubTask,
  DirectorTask,
  QualityGate,
  LiberationLevel,
  Checkpoint,
  BuildContextOptions,
} from '@shared/types'
import { agentChat, pickAgentForRole } from './agent-service'
import { type StreamChunk } from './llm-service'
import { loadSkillForAgent } from './skill-service'
import { runQualityGate } from './quality-service'
import {
  saveCheckpoint,
  loadCheckpoints,
} from './tracking-service'

// ===== P2 导演式 Agent 编排 =====
// 自然语言意图 → 拆解子任务 → 依赖调度 → 多 Agent 分派 → 检查点落库 → 审批节点

export interface DirectorProgress {
  taskId: string
  stageIndex: number
  label: string
  agentRole: string
  status: 'running' | 'completed' | 'awaiting-approval' | 'paused' | 'error'
  output?: string
  quality?: QualityGate
  // 需要作者审批时的提示（Human-in-the-Loop）
  approvalRequest?: { subtaskId: string; reason: string }
}

// 把一句灵感按解放度拆解成标准子任务链
// L1 作者全程主导（全审批）；L2/L3 关键节点（大纲定稿/黄金三章/卷末）强制 Human-in-the-Loop；L4 全自动仅里程碑审批
export function buildDirectorPlan(
  intent: string,
  level: LiberationLevel = 'L2'
): SubTask[] {
  // 判断某子任务是否「需作者审批」（return true 表示需审批 → autoApprove=false）
  const needsApproval = (role: string, id: string): boolean => {
    if (level === 'L1') return true // 全程主导
    if (level === 'L4') return id === 'review' // 仅里程碑（卷末）审批
    // L2/L3：关键节点需审批——大纲定稿(outline)、黄金三章(golden)、正文(chapters)、卷末(review)
    return role === 'writer' || id === 'outline' || id === 'review'
  }
  const base: Omit<SubTask, 'id' | 'status'>[] = [
    {
      agentRole: 'director',
      skillRefs: ['story-setup'],
      input: `基于意图「${intent}」完成立项设定（一句话简介+世界观锚点+主角+爽点链）。`,
      autoApprove: !needsApproval('director', 'setup'),
      dependsOn: [],
    },
    {
      agentRole: 'planner',
      skillRefs: ['story-outline-gen'],
      input: '基于设定书生成卷级+章级大纲，前10章强化钩子。',
      autoApprove: !needsApproval('planner', 'outline'),
      dependsOn: ['setup'],
    },
    {
      agentRole: 'writer',
      skillRefs: ['story-golden-opening'],
      input: '生成黄金三章细纲与正文样例（前三章）。',
      autoApprove: !needsApproval('writer', 'golden'),
      dependsOn: ['outline'],
    },
    {
      agentRole: 'writer',
      skillRefs: ['story-continue'],
      input: '按大纲与黄金三章续写后续正文（日更节奏）。',
      autoApprove: !needsApproval('writer', 'chapters'),
      dependsOn: ['golden'],
    },
    {
      agentRole: 'consistency',
      skillRefs: ['story-consistency', 'story-pacing'],
      input: '卷末对全文做一致性+节奏审查，输出冲突清单。',
      autoApprove: !needsApproval('consistency', 'review'),
      dependsOn: ['chapters'],
    },
  ]
  const alias = ['setup', 'outline', 'golden', 'chapters', 'review']
  return base.map((t, i) => ({ ...t, id: alias[i], status: 'pending' as const }))
}

// 导演计划的子任务角色名与 Agent 角色枚举存在错位（planner/consistency 不在 AGENT_ROLE_LABELS 中，
// UI 角色网格无法创建对应 Agent）→ 按语义映射到现有角色，否则导演编排必然在 outline 层报错暂停
const ROLE_ALIASES: Record<string, AgentConfig['role']> = {
  planner: 'architect',
  consistency: 'checker',
}

function getAgent(role: string, agents: AgentConfig[]): AgentConfig | undefined {
  const mapped = ROLE_ALIASES[role] ?? role
  // D-T4-2：同角色并存空 key 种子行与用户行时，优先选已配 key 的
  return pickAgentForRole(agents, mapped)
}

async function* runSubTask(
  subtask: SubTask,
  agent: AgentConfig,
  taskId: string,
  novelId: string,
  index: number,
  options: BuildContextOptions,
  signal?: AbortSignal
): AsyncGenerator<DirectorProgress> {
  yield {
    taskId,
    stageIndex: index,
    label: subtask.input.slice(0, 40),
    agentRole: subtask.agentRole,
    status: 'running',
  }
  const skillStr = loadSkillForAgent(subtask.skillRefs, subtask.input)
  const sysPrompt = `${agent.systemPrompt}\n\n${skillStr}`
  let output = ''
  // 防御：LLM 调用失败必须显式透出 error 事件（否则 drain 静默结束，
  // UI 无感知、checkpoint 不落库、task 却标记 completed —— 失败被完全吞没）
  try {
    for await (const chunk of agentChat(
      { ...agent, systemPrompt: sysPrompt },
      subtask.input,
      options,
      signal
    )) {
      output += (chunk as StreamChunk).content
    }
  } catch (err) {
    subtask.status = 'rejected'
    yield {
      taskId,
      stageIndex: index,
      label: subtask.input.slice(0, 40),
      agentRole: subtask.agentRole,
      status: 'error' as const,
      output: `子任务执行失败：${err instanceof Error ? err.message : String(err)}`,
    }
    return
  }
  subtask.output = output
  subtask.status = 'completed'

  // 质量门禁：正文类任务（writer）产出后强制去AI味 Gate
  let quality: QualityGate | undefined
  if (subtask.agentRole === 'writer') {
    quality = await runQualityGate(output)
    subtask.quality = quality
  }

  const cp: Checkpoint = {
    id: `${taskId}-${subtask.id}`,
    taskId,
    novelId,
    stageIndex: index,
    agentRole: subtask.agentRole,
    output,
    quality,
    status: quality && !quality.passed ? 'awaiting-approval' : 'completed',
    createdAt: new Date().toISOString(),
  }
  await saveCheckpoint(novelId, cp)

  yield {
    taskId,
    stageIndex: index,
    label: subtask.input.slice(0, 40),
    agentRole: subtask.agentRole,
    status: cp.status === 'awaiting-approval' ? 'awaiting-approval' : 'completed',
    output: output.slice(0, 500),
    quality,
    approvalRequest:
      cp.status === 'awaiting-approval'
        ? { subtaskId: subtask.id, reason: quality?.report || '质量门禁未通过' }
        : undefined,
  }
}

export function createDirectorTask(
  novelId: string,
  intent: string,
  level: LiberationLevel = 'L2'
): DirectorTask {
  const decomposed = buildDirectorPlan(intent, level)
  const now = new Date().toISOString()
  return {
    id: `task-${Date.now()}`,
    novelId,
    intent,
    level,
    decomposed,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
}

// Kahn 拓扑分层：依赖全部就绪（indegree=0）的子任务归入同一层，层内可并发，层间严格串行
export function topoLayers(task: DirectorTask): SubTask[][] {
  const byId = new Map(task.decomposed.map((s) => [s.id, s]))
  const indeg = new Map(
    task.decomposed.map((s) => [s.id, s.dependsOn?.filter((d) => byId.has(d)).length ?? 0])
  )
  const remaining = new Set(task.decomposed.map((s) => s.id))
  const layers: SubTask[][] = []
  while (remaining.size) {
    const layer = [...remaining]
      .filter((id) => (indeg.get(id) ?? 0) === 0)
      .map((id) => byId.get(id)!)
    if (!layer.length) break // 存在环，兜底退出避免死循环
    layers.push(layer)
    for (const s of layer) remaining.delete(s.id)
    for (const s of task.decomposed) {
      if (remaining.has(s.id)) {
        const ready = s.dependsOn?.filter((d) => !remaining.has(d)).length ?? 0
        indeg.set(s.id, (indeg.get(s.id) ?? 0) - ready)
      }
    }
  }
  return layers
}

// 审批原因：透出 L1/L2-L3/L4 分级文案，保证 UI 与流水线语义一致
function approvalReason(level: LiberationLevel | undefined, st: SubTask): string {
  const lvl = level ?? 'L2'
  if (lvl === 'L1') return 'L1 全程主导：需作者逐项审批后继续'
  if (lvl === 'L4') return 'L4 全自动：仅里程碑（卷末 review）需作者审批'
  const labelMap: Record<string, string> = {
    setup: '立项设定',
    outline: '大纲定稿',
    golden: '黄金三章',
    chapters: '正文续写',
    review: '卷末审查',
  }
  return `L2/L3 关键节点（${labelMap[st.id] ?? st.id}）需作者审批（Human-in-the-Loop）`
}

// 运行导演计划：按依赖图分层 —— 层内真并发（各 generator 独立抽干、事件实时透出），层间严格串行。
// 注意：进度不再整层缓冲——任一子任务产生事件即 yield，UI 能实时看到 running/完成状态；
// 屏障语义保持：paused/error 判定仍等整层收尾（让在途 checkpoint 写完），不半途打断。
export async function* runDirector(
  task: DirectorTask,
  agents: AgentConfig[],
  novelId: string,
  options: BuildContextOptions,
  signal?: AbortSignal
): AsyncGenerator<DirectorProgress> {
  const layers = topoLayers(task)
  for (const layer of layers) {
    if (signal?.aborted) return
    const generators = layer.map((st) => {
      const index = task.decomposed.indexOf(st)
      if (st.status === 'completed' || st.status === 'rejected') return null
      const agent = getAgent(st.agentRole, agents)
      if (!agent) {
        return (async function* () {
          yield {
            taskId: task.id,
            stageIndex: index,
            label: st.input.slice(0, 40),
            agentRole: st.agentRole,
            status: 'error' as const,
            output: `未找到角色 ${st.agentRole} 的 Agent 配置`,
          }
        })()
      }
      // 审批节点：autoApprove=false → 暂停等待作者接管（分级原因透出）
      if (!st.autoApprove) {
        return (async function* () {
          yield {
            taskId: task.id,
            stageIndex: index,
            label: st.input.slice(0, 40),
            agentRole: st.agentRole,
            status: 'awaiting-approval' as const,
            approvalRequest: { subtaskId: st.id, reason: approvalReason(task.level, st) },
          }
        })()
      }
      return runSubTask(st, agent, task.id, novelId, index, options, signal)
    })

    let paused = false
    // 层内真并发：每个 generator 独立抽干进共享队列；消费循环发现事件立即 yield。
    // 事件到达通过 waiter 唤醒（无轮询）；drains 全部完成后置 done 退出。
    const pending: DirectorProgress[] = []
    let notify: (() => void) | null = null
    const push = (p: DirectorProgress) => {
      pending.push(p)
      notify?.()
      notify = null
    }
    const waitEvent = () => new Promise<void>((r) => { notify = r })

    // 用 holder 对象记录 Promise.all 的 rejection：直接用 `let x: T | null` 会被 TS
    // 收窄成 never（闭包内的赋值对控制流分析不可见）。
    const failure = { err: null as unknown }
    const drains = generators
      .filter((g): g is AsyncGenerator<DirectorProgress> => !!g)
      .map((g) =>
        (async () => {
          for await (const p of g) push(p)
        })()
      )
    const drainedAll = Promise.all(drains)
    let done = false
    drainedAll.then(
      () => {
        done = true
        notify?.()
        notify = null
      },
      (err) => {
        failure.err = err
        done = true
        notify?.()
        notify = null
      }
    )

    while (!done || pending.length) {
      if (failure.err !== null) throw failure.err
      if (pending.length) {
        const p = pending.shift()!
        yield p
        if (p.status === 'awaiting-approval' || p.status === 'paused' || p.status === 'error') {
          paused = true
        }
        continue
      }
      await waitEvent()
    }
    if (paused) {
      task.status = 'paused'
      return
    }
  }
  task.status = 'completed'
}

// 断点续跑：从 SQLite 检查点恢复 —— 标记已 completed 的子任务并回灌 output，再继续拓扑调度
export async function* resumeDirector(
  task: DirectorTask,
  agents: AgentConfig[],
  novelId: string,
  options: BuildContextOptions,
  signal?: AbortSignal
): AsyncGenerator<DirectorProgress> {
  const cps = await loadCheckpoints(novelId)
  for (const c of cps) {
    const sid = c.id.replace(`${task.id}-`, '')
    const st = task.decomposed.find((s) => s.id === sid)
    if (st && c.status === 'completed') {
      st.status = 'completed'
      st.output = c.output
    }
  }
  yield* runDirector(task, agents, novelId, options, signal)
}

/**
 * 从 SQLite 检查点重建导演任务（跨会话崩溃/断网续跑）。
 * 复用检查点中记录的 task_id 与 intent，保证 checkpoint id（${taskId}-${subtaskId}）可匹配回灌。
 */
export async function buildResumeTask(
  novelId: string,
  level: LiberationLevel
): Promise<DirectorTask | null> {
  const cps = await loadCheckpoints(novelId)
  if (!cps.length) return null
  const taskId = cps[0].taskId
  const intent = cps[0].intent || ''
  const now = new Date().toISOString()
  return {
    id: taskId,
    novelId,
    intent,
    level,
    decomposed: buildDirectorPlan(intent, level),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
}

export async function loadDirectorCheckpoints(novelId: string): Promise<Checkpoint[]> {
  return loadCheckpoints(novelId)
}
