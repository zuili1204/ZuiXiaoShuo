import type { AgentConfig, AgentLoopEvent, AgentToolCall } from '@shared/types'
import { LLM_PROVIDERS, resolveEndpoint, isAnthropicProvider } from '@shared/constants'
import { classifyError, getFallbackProvider } from '../utils/error-handler'
import { agentConfigService } from './data-service'

export interface StreamChunk {
  content: string
  done?: boolean
  usage?: LLMUsage
  finishReason?: string // 流结束原因（stop/length 等）：用于识别"思考耗尽预算→空正文"
  // Agent 工具循环事件（文档 M2）：用于 UI 展示"AI 正在调资料"
  toolEvent?: AgentLoopEvent
  // P2-7 降级事件：本次流实际使用的 Provider 与主配置不同
  fallback?: { from: string; to: string; reason: string }
}

// ===== P2-7：错误分类 → 指数退避重试 → 跨 Provider 降级 =====
// 作用域：仅覆盖「建立连接」阶段（解密/组包/fetch/状态码检查）。
// 流中途的网络中断不在此列——重试会导致已 yield 的内容重复，直接抛给上层更安全。

export interface RetryOptions {
  attempts?: number      // retryable 时最多额外重试次数（默认 2）
  baseDelayMs?: number   // 指数退避基数（默认 800ms → 800/1600）
}

const DEFAULT_RETRY: Required<RetryOptions> = { attempts: 2, baseDelayMs: 800 }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))
}

// 找一个已配置 Key 的降级 agent（按 provider 匹配）
async function findConfiguredAgent(provider: string): Promise<AgentConfig | null> {
  try {
    const agents = await agentConfigService.getAll()
    return agents.find((a) => a.provider === provider && a.apiKeyEncrypted) || null
  } catch {
    return null
  }
}

export interface EstablishedCall<T> {
  result: T
  usedAgent: AgentConfig
  fallback?: { from: string; to: string; reason: string }
}

/**
 * 带韧性的连接建立：失败先 classifyError 分类，
 * retryable → 指数退避重试 N 次；仍失败或不可重试 → getFallbackProvider
 * 找已配 Key 的降级 agent 重开一次；全失败则抛出**最后一次主配置错误**。
 * T 由调用方决定：streamChat 传 ReadableStream，chatWithTools 传 Response。
 */
async function establishWithResilience<T>(
  agent: AgentConfig,
  open: (a: AgentConfig) => Promise<T>,
  signal: AbortSignal | undefined,
  retryOpts?: RetryOptions
): Promise<EstablishedCall<T>> {
  const { attempts, baseDelayMs } = { ...DEFAULT_RETRY, ...retryOpts }
  let lastErr: unknown
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return { result: await open(agent), usedAgent: agent }
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw e
      lastErr = e
      const classified = classifyError(e)
      if (!classified.retryable || attempt >= attempts) break
      await sleep(baseDelayMs * 2 ** attempt, signal).catch((err) => { throw isAbort(err) ? err : e })
    }
  }
  // 主配置重试耗尽/不可重试 → 尝试降级
  const fbProvider = getFallbackProvider(agent.provider)
  if (fbProvider && fbProvider !== agent.provider) {
    const fbAgent = await findConfiguredAgent(fbProvider)
    if (fbAgent) {
      try {
        const classified = classifyError(lastErr)
        return {
          result: await open(fbAgent),
          usedAgent: fbAgent,
          fallback: { from: agent.provider, to: fbProvider, reason: classified.title },
        }
      } catch {
        // 降级也失败：抛主配置的原始错误（信息最完整）
      }
    }
  }
  throw lastErr
}

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  model: string
}

// OpenAI 兼容协议的 tool 定义
export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// 是否支持 function calling 工具循环（仅 OpenAI 兼容协议；Anthropic 本版降级为纯流式）
export function supportsTools(agent: AgentConfig): boolean {
  return !isAnthropicProvider(agent.provider)
}

// 非流式 + 工具调用（Agent 循环核心）。仅 OpenAI 兼容协议。
export async function chatWithTools(
  agent: AgentConfig,
  messages: any[],
  tools: OpenAIToolDef[],
  signal?: AbortSignal,
  retryOpts?: RetryOptions
): Promise<{ content: string; toolCalls: AgentToolCall[]; usage?: LLMUsage; finishReason?: string }> {
  const apiKey = await decryptKey(agent.apiKeyEncrypted)
  if (!apiKey) throw new Error('API Key 未配置或未正确保存，请先填写并保存密钥')
  const endpoint = buildEndpoint(agent)
  if (!endpoint) throw new Error('接口地址为空：自定义 Provider 需填写 Endpoint')
  if (!agent.model) throw new Error('模型名为空')

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort())
  }

  // open() 可能以主配置或降级 agent 身份各执行一次（P2-7）
  const open = async (a: AgentConfig): Promise<Response> => {
    const key = await decryptKey(a.apiKeyEncrypted)
    if (!key) throw new Error('API Key 未配置或未正确保存，请先填写并保存密钥')
    const ep = buildEndpoint(a)
    if (!ep) throw new Error('接口地址为空：自定义 Provider 需填写 Endpoint')
    const response = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: a.model.trim(),
        messages,
        temperature: a.temperature,
        max_tokens: a.maxTokens,
        ...(a.topP != null ? { top_p: a.topP } : {}),
        ...thinkingDisabled(a),
        stream: false,
        tools,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await safeErrorText(response)
      throw new Error(`LLM API Error (${response.status}): ${detail}`)
    }
    return response
  }

  const est = await establishWithResilience<Response>(agent, open, signal)
  const data = await est.result.json()
  const message = data.choices?.[0]?.message || {}
  const content = typeof message.content === 'string' ? message.content : ''
  const toolCalls: AgentToolCall[] = (message.tool_calls || []).map((tc: any) => ({
    id: tc.id,
    name: tc.function?.name || '',
    arguments:
      typeof tc.function?.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {}),
  }))
  const usage: LLMUsage | undefined = data.usage
    ? {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
        model: data.model || est.usedAgent.model || '',
      }
    : undefined
  return { content, toolCalls, usage, finishReason: data.choices?.[0]?.finish_reason as string | undefined }
}

// 解密 API Key（密文 → 明文），用于发起请求
async function decryptKey(encrypted?: string): Promise<string> {
  if (!encrypted) return ''
  try {
    return (await window.electronAPI.key.decrypt(encrypted)).trim()
  } catch (e) {
    console.error('Failed to decrypt API key:', e)
    return ''
  }
}

// q23 实证（2026-10-03）：deepseek 思考型模型（flash 系列）把 reasoning 计入 max_tokens，
// 思考耗尽预算时返回 finish=length、content 为空 —— UI 表现为"气泡空白且无报错"。
// 长文产出角色（writer/polisher）需要的是直接输出正文，故对 deepseek 协议显式关闭思考；
// 分析类角色（architect/director 等）保留思考，产出短、预算耗尽风险低。
function thinkingDisabled(agent: AgentConfig): { thinking?: { type: 'disabled' } } {
  if (agent.provider !== 'deepseek') return {}
  if (agent.role !== 'writer' && agent.role !== 'polisher') return {}
  return { thinking: { type: 'disabled' } }
}

// 解析最终请求地址
function buildEndpoint(agent: AgentConfig): string {
  if (agent.provider === 'custom') {
    const ep = (agent.endpoint || '').trim()
    // 允许用户填完整 chat/completions URL 或 base URL
    if (ep && ep.includes('/chat/completions')) return ep
    if (ep) return ep.replace(/\/$/, '') + '/chat/completions'
    return ''
  }
  const base = resolveEndpoint(agent.provider)
  return base ? `${base.replace(/\/$/, '')}/chat/completions` : ''
}

// OpenAI 兼容流式调用（openai / deepseek / custom 均走此协议）
async function callOpenAICompatible(
  endpoint: string,
  apiKey: string,
  agent: AgentConfig,
  messages: { role: string; content: string }[],
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: (agent.model || '').trim(),
      messages,
      temperature: agent.temperature,
      max_tokens: agent.maxTokens,
      ...(agent.topP != null ? { top_p: agent.topP } : {}),
      ...thinkingDisabled(agent),
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  })

  if (!response.ok) {
    const errText = await safeErrorText(response)
    throw new Error(`LLM API Error (${response.status}): ${errText}`)
  }
  return response.body!
}

// Anthropic 流式调用（独立协议：x-api-key、system 顶层字段、content_block 解析）
async function callAnthropic(
  endpoint: string,
  apiKey: string,
  agent: AgentConfig,
  messages: { role: string; content: string }[],
  signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
  const system = messages.find((m) => m.role === 'system')?.content || ''
  const chatMessages = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))

  const apiVersion = '2023-06-01'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': apiVersion,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: agent.model,
      system,
      messages: chatMessages,
      max_tokens: agent.maxTokens,
      temperature: agent.temperature,
      ...(agent.topP != null ? { top_p: agent.topP } : {}),
      stream: true,
    }),
    signal,
  })

  if (!response.ok) {
    const errText = await safeErrorText(response)
    throw new Error(`Anthropic API Error (${response.status}): ${errText}`)
  }
  return response.body!
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    // 尝试解析为 JSON（如 DeepSeek/OpenAI 的错误体 { error: { message } }），否则原样返回
    try {
      const json = JSON.parse(text)
      if (json?.error?.message) return json.error.message as string
      if (json?.message) return json.message as string
    } catch {
      /* 非 JSON，按文本返回 */
    }
    return text || response.statusText
  } catch {
    return response.statusText
  }
}

export async function* streamChat(
  agent: AgentConfig,
  messages: { role: string; content: string }[],
  signal?: AbortSignal,
  retryOpts?: RetryOptions
): AsyncGenerator<StreamChunk> {
  const apiKey = await decryptKey(agent.apiKeyEncrypted)
  if (!apiKey) {
    throw new Error('API Key 未配置或未正确保存，请先填写并保存密钥')
  }

  const endpoint = buildEndpoint(agent)
  if (!endpoint) {
    throw new Error('接口地址为空：自定义 Provider 需填写 Endpoint')
  }
  if (!agent.model) {
    throw new Error('模型名为空')
  }

  // open() 可能以主配置或降级 agent 身份各执行一次（P2-7）
  const open = async (a: AgentConfig): Promise<ReadableStream<Uint8Array>> => {
    const key = await decryptKey(a.apiKeyEncrypted)
    if (!key) throw new Error('API Key 未配置或未正确保存，请先填写并保存密钥')
    const ep = buildEndpoint(a)
    if (!ep) throw new Error('接口地址为空：自定义 Provider 需填写 Endpoint')
    if (isAnthropicProvider(a.provider)) return callAnthropic(ep, key, a, messages, signal)
    return callOpenAICompatible(ep, key, a, messages, signal)
  }

  const est = await establishWithResilience<ReadableStream<Uint8Array>>(agent, open, signal, retryOpts)
  // 降级发生：先发一条 fallback 事件供 UI 提示，再继续正常流
  if (est.fallback) {
    yield { content: '', done: false, fallback: est.fallback }
  }
  const isAnthropic = isAnthropicProvider(est.usedAgent.provider)
  const body = est.result

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishReason: string | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const data = trimmed.slice(trimmed.indexOf(':') + 1).trim()
      if (data === '[DONE]') return
      try {
        const parsed = JSON.parse(data)
        if (isAnthropic) {
          // Anthropic SSE: type=content_block_delta, delta.text
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { content: parsed.delta.text as string, done: false }
          }
          // Anthropic message_end 包含 usage
          if (parsed.type === 'message_end' && parsed.message?.usage) {
            yield {
              content: '',
              done: true,
              usage: {
                inputTokens: parsed.message.usage.input_tokens ?? 0,
                outputTokens: parsed.message.usage.output_tokens ?? 0,
                model: est.usedAgent.model || '',
              },
            }
          }
        } else {
          // OpenAI-compatible: 正常内容块
          const choice = parsed.choices?.[0]
          const content = choice?.delta?.content
          if (content) yield { content: content as string, done: false }
          // 结束原因（可能出现在最后一个 choices 块上）
          if (choice?.finish_reason) finishReason = choice.finish_reason as string
          // 流式最终 usage 块（可能带 choices:[] 空数组，不能用 !parsed.choices 判断）
          if (parsed.usage && (!parsed.choices || parsed.choices.length === 0)) {
            yield {
              content: '',
              done: true,
              finishReason,
              usage: {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
                model: parsed.model || est.usedAgent.model || '',
              },
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }
  }
  yield { content: '', done: true, finishReason }
}

// 非流式聊天
export async function chat(
  agent: AgentConfig,
  messages: { role: string; content: string }[]
): Promise<string> {
  let result = ''
  for await (const chunk of streamChat(agent, messages)) {
    if (!chunk.done) result += chunk.content
  }
  return result
}

// 测试连接：发送一个最小请求，验证 key / endpoint / 模型可达
export async function testConnection(agent: AgentConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const apiKey = await decryptKey(agent.apiKeyEncrypted)
    if (!apiKey) {
      return { ok: false, message: '未配置 API Key，请先填写并保存密钥' }
    }
    const endpoint = buildEndpoint(agent)
    if (!endpoint) {
      return { ok: false, message: '接口地址为空（自定义 Provider 需填写 Endpoint）' }
    }
    if (!agent.model) {
      return { ok: false, message: '模型名为空' }
    }

    if (isAnthropicProvider(agent.provider)) {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: agent.model.trim(),
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      if (!resp.ok) {
        const detail = await safeErrorText(resp)
        console.error('[testConnection] Anthropic 返回错误：', detail)
        return { ok: false, message: `连接失败 (${resp.status}) [${agent.provider}] ${endpoint}：${detail}` }
      }
      return { ok: true, message: '连接成功' }
    }

    // OpenAI 兼容
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: agent.model.trim(),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
      }),
    })
    if (!resp.ok) {
      const detail = await safeErrorText(resp)
      console.error('[testConnection] DeepSeek/OpenAI 返回错误：', detail)
      return { ok: false, message: `连接失败 (${resp.status}) [${agent.provider}] ${endpoint}：${detail}` }
    }
    return { ok: true, message: '连接成功' }
  } catch (e) {
    return { ok: false, message: `连接异常：${(e as Error).message}` }
  }
}

// 兼容旧引用
void LLM_PROVIDERS
