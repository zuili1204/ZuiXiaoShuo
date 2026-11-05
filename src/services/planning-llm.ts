/**
 * 规划工作台的统一模型调用入口。
 *
 * 与 ai-outline.callLLM 的区别：
 * - 强制走 PLAN_STAGE_SKILLS 路由，注入对应步骤 + 方法论参考 + 提案契约；
 * - 用 skillPromptOverride 替换系统技能段，避免触发词误命中其他技能；
 * - 要求统一 JSON 信封，先本地校验，再经主进程跑 validate-proposal.js；
 * - 校验失败只修复一次，仍失败不返回半成品，交给上层提示重试。
 */
import type { AgentConfig } from '@shared/types'
import { agentChat } from './agent-service'
import { ActionLog } from './log-service'
import {
  assertPlanRoutesValid,
  buildPlanningSkillPrompt,
  getPlanningContractText,
  resolvePlanRoute,
  type PlanQuality,
  type PlanSkillRoute,
  type PlanStage,
} from './planning-skill-service'

export interface PlanEnvelope<T = Record<string, unknown>> {
  stage: PlanStage
  baseRevision: string
  payload: T
  warnings: string[]
}

export interface PlanValidationOutcome {
  ok: boolean
  errors: string[]
  /** true = 当前环境没有主进程校验服务，仅做了信封检查 */
  skipped?: boolean
}

export interface PlanLLMOptions {
  quality?: PlanQuality
  signal?: AbortSignal
  /** 本次提案基于的修订号；未传时生成 draft 时间戳 */
  baseRevision?: string
  /** 已写章 id：契约校验会拒绝这些章出现在提案里 */
  writtenIds?: string[]
  /** 校验失败后的修复次数，默认 1 */
  maxRepair?: number
}

export interface PlanLLMResult<T = Record<string, unknown>> {
  stage: PlanStage
  route: PlanSkillRoute
  envelope: PlanEnvelope<T>
  payload: T
  warnings: string[]
  raw: string
  repaired: boolean
  validation: PlanValidationOutcome
}

export class PlanProposalError extends Error {
  readonly stage: PlanStage
  readonly errors: string[]
  readonly raw: string

  constructor(stage: PlanStage, errors: string[], raw: string) {
    super(`规划提案未通过校验：${errors.join('；')}`)
    this.name = 'PlanProposalError'
    this.stage = stage
    this.errors = errors
    this.raw = raw
  }
}

let routesChecked = false

function ensureRoutes(): void {
  if (routesChecked) return
  assertPlanRoutesValid()
  routesChecked = true
}

export function extractPlanJson(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

function buildOutputInstruction(stage: PlanStage, baseRevision: string): string {
  return (
    '## 输出要求\n' +
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。外层信封必须为：\n' +
    '{\n' +
    `  "stage": "${stage}",\n` +
    `  "baseRevision": "${baseRevision}",\n` +
    '  "payload": { /* 严格按上方契约中该阶段的字段 */ },\n' +
    '  "warnings": []\n' +
    '}\n' +
    'baseRevision 必须原样回传；payload 字段、数量与范围必须满足上方契约；没有 warnings 也要返回空数组。'
  )
}

function buildUserMessage(stage: PlanStage, baseRevision: string, taskPrompt: string): string {
  return [`## 本次任务\n${taskPrompt}`, buildOutputInstruction(stage, baseRevision)].join('\n\n')
}

export function parsePlanEnvelope<T = Record<string, unknown>>(
  raw: string,
  stage: PlanStage,
  expectedRevision: string,
): { envelope: PlanEnvelope<T> | null; errors: string[] } {
  const jsonStr = extractPlanJson(raw)
  if (!jsonStr) return { envelope: null, errors: ['输出中没有 JSON 对象'] }

  let data: unknown
  try {
    data = JSON.parse(jsonStr)
  } catch {
    return { envelope: null, errors: ['输出 JSON 无法解析'] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { envelope: null, errors: ['输出必须是 JSON 对象'] }
  }

  const obj = data as Record<string, unknown>
  const errors: string[] = []
  if (obj.stage !== stage) errors.push(`stage 应为 ${stage}，实际为 ${String(obj.stage)}`)
  if (typeof obj.baseRevision !== 'string' || !obj.baseRevision.trim()) {
    errors.push('baseRevision 必须是非空字符串')
  } else if (obj.baseRevision !== expectedRevision) {
    errors.push(`baseRevision 必须原样回传 ${expectedRevision}`)
  }
  if (!obj.payload || typeof obj.payload !== 'object' || Array.isArray(obj.payload)) {
    errors.push('payload 必须是对象')
  }
  if (!Array.isArray(obj.warnings) || !obj.warnings.every((w) => typeof w === 'string')) {
    errors.push('warnings 必须是字符串数组')
  }
  if (errors.length) return { envelope: null, errors }

  return {
    envelope: {
      stage,
      baseRevision: obj.baseRevision as string,
      payload: obj.payload as T,
      warnings: [...(obj.warnings as string[])],
    },
    errors: [],
  }
}

async function validateWithHost<T>(
  stage: PlanStage,
  envelope: PlanEnvelope<T>,
  writtenIds: string[],
): Promise<PlanValidationOutcome> {
  const api = (window as unknown as { electronAPI?: { plan?: { validate?: (input: unknown) => Promise<unknown> } } })
    .electronAPI
  if (!api?.plan?.validate) {
    return { ok: true, errors: [], skipped: true }
  }
  const res = (await api.plan.validate({ stage, proposal: envelope, writtenIds })) as
    | { ok?: boolean; errors?: unknown }
    | null
  if (!res || typeof res.ok !== 'boolean') {
    throw new PlanProposalError(stage, ['主进程提案校验返回格式异常'], JSON.stringify(envelope))
  }
  return {
    ok: res.ok,
    errors: Array.isArray(res.errors) ? res.errors.map(String) : [],
  }
}

async function collectOnce(
  agent: AgentConfig,
  novelId: string,
  route: PlanSkillRoute,
  skillPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  let acc = ''
  for await (const chunk of agentChat(
    { ...agent, skillRefs: route.skillRefs },
    userMessage,
    {
      novelId,
      previousMessages: [],
      mode: 'chat',
      agentMode: 'ask',
      enableTools: false,
      skillPromptOverride: skillPrompt,
    },
    signal,
  )) {
    if (chunk.content) acc += chunk.content
    if (signal?.aborted) return ''
  }
  return acc
}

/** 空响应重试一次（与 ai-outline.callLLM 同口径） */
async function collectWithRetry(
  agent: AgentConfig,
  novelId: string,
  route: PlanSkillRoute,
  skillPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await collectOnce(agent, novelId, route, skillPrompt, userMessage, signal)
    if (signal?.aborted) return ''
    if (out.trim()) return out
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000))
  }
  return ''
}

function buildRepairMessage(stage: PlanStage, baseRevision: string, raw: string, errors: string[]): string {
  return (
    '上一次输出不符合规划提案契约。请只返回修正后的 JSON 对象，不要解释、不要 Markdown 代码块。\n' +
    `必须保留 stage="${stage}" 与 baseRevision="${baseRevision}"。\n\n` +
    `校验错误：\n${errors.map((e) => `- ${e}`).join('\n')}\n\n` +
    `上一次输出（供修正，最多 6000 字）：\n${raw.slice(0, 6000)}`
  )
}

export async function callPlanLLM<T = Record<string, unknown>>(
  agent: AgentConfig,
  novelId: string,
  stage: PlanStage,
  taskPrompt: string,
  options: PlanLLMOptions = {},
): Promise<PlanLLMResult<T>> {
  ensureRoutes()
  const quality = options.quality ?? 'standard'
  const route = resolvePlanRoute(stage, quality)
  const baseRevision = options.baseRevision?.trim() || `draft-${Date.now()}`
  const writtenIds = (options.writtenIds ?? []).filter((id) => typeof id === 'string' && id.trim())
  const skillPrompt = buildPlanningSkillPrompt(stage, quality)
  if (!skillPrompt.trim()) {
    throw new Error(`规划技能提示词为空：${stage}`)
  }
  // 契约文本已在 skillPrompt 中；这里显式检查一次，契约文件缺失时立即失败而不是发请求
  getPlanningContractText(stage, quality)

  ActionLog.agent(`规划 ${stage}`, {
    skill: route.primarySkill,
    support: route.supportSkills.join(',') || '-',
    quality,
  })

  let raw = await collectWithRetry(
    agent,
    novelId,
    route,
    skillPrompt,
    buildUserMessage(stage, baseRevision, taskPrompt),
    options.signal,
  )
  if (options.signal?.aborted) {
    throw new PlanProposalError(stage, ['请求已取消'], '')
  }
  if (!raw.trim()) {
    throw new PlanProposalError(stage, ['模型返回空内容'], '')
  }

  let parsed = parsePlanEnvelope<T>(raw, stage, baseRevision)
  let validation: PlanValidationOutcome = parsed.envelope
    ? await validateWithHost(stage, parsed.envelope, writtenIds)
    : { ok: false, errors: parsed.errors }

  const maxRepair = options.maxRepair ?? 1
  let repaired = false
  if ((!parsed.envelope || !validation.ok) && maxRepair > 0) {
    const errors = parsed.errors.length ? parsed.errors : validation.errors
    raw = await collectWithRetry(
      agent,
      novelId,
      route,
      skillPrompt,
      buildRepairMessage(stage, baseRevision, raw, errors),
      options.signal,
    )
    repaired = true
    if (options.signal?.aborted) {
      throw new PlanProposalError(stage, ['请求已取消'], '')
    }
    parsed = parsePlanEnvelope<T>(raw, stage, baseRevision)
    validation = parsed.envelope
      ? await validateWithHost(stage, parsed.envelope, writtenIds)
      : { ok: false, errors: parsed.errors }
  }

  if (!parsed.envelope || !validation.ok) {
    const errors = parsed.errors.length ? parsed.errors : validation.errors
    throw new PlanProposalError(stage, errors.length ? errors : ['提案校验失败'], raw)
  }

  ActionLog.agent(`规划 ${stage} 完成`, {
    schema: route.outputSchema,
    warnings: parsed.envelope.warnings.length,
    repaired,
  })

  return {
    stage,
    route,
    envelope: parsed.envelope,
    payload: parsed.envelope.payload,
    warnings: parsed.envelope.warnings,
    raw,
    repaired,
    validation,
  }
}
