/**
 * Agent 工具循环（文档 M2）。
 *
 * 流程：调用 LLM（带 tools）→ 若返回 tool_calls，执行工具并把结果回填消息，
 * 再次调用 LLM，直到模型不再请求工具为止。期间通过 onEvent 抛出 tool_use /
 * tool_result / message 事件，供 UI 实时展示"AI 正在调资料"。
 */
import type { AgentConfig, AgentLoopEvent, AgentTool } from '@shared/types'
import { chatWithTools, type StreamChunk, type OpenAIToolDef } from './llm-service'
import { toOpenAISchema, executeTool } from './tool-service'
import { ActionLog } from './log-service'

function parseArgs(raw: string): any {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

export async function* runAgentLoop(params: {
  agent: AgentConfig
  messages: any[]
  tools: AgentTool[]
  onEvent?: (e: AgentLoopEvent) => void
  signal?: AbortSignal
  maxIterations?: number
}): AsyncGenerator<StreamChunk> {
  const { agent, tools, onEvent, signal, maxIterations = 60 } = params
  const toolDefs: OpenAIToolDef[] = toOpenAISchema(tools)
  const history: any[] = [...params.messages]
  let iterations = 0

  while (iterations < maxIterations) {
    iterations++
    onEvent?.({ type: 'iteration', index: iterations, max: maxIterations })

    let resp: Awaited<ReturnType<typeof chatWithTools>>
    try {
      resp = await chatWithTools(agent, history, toolDefs, signal)
    } catch (e) {
      yield { content: `\n[工具循环错误] ${(e as Error).message}`, done: true }
      return
    }
    const { content, toolCalls, usage } = resp

    if (toolCalls && toolCalls.length > 0) {
      // 记录 assistant 的工具调用（OpenAI 形状）
      history.push({
        role: 'assistant',
        content: content || '',
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      })
      for (const tc of toolCalls) {
        const args = parseArgs(tc.arguments)
        const useEvent: AgentLoopEvent = { type: 'tool_use', id: tc.id, name: tc.name, arguments: args }
        onEvent?.(useEvent)
        yield { content: '', toolEvent: useEvent }
        // 记录 AI 工具调用指令（操作指令）
        ActionLog.tool(`调用 ${tc.name}`, args)

        const result = await executeTool(tc.name, args, tools)
        const resultEvent: AgentLoopEvent = { type: 'tool_result', id: tc.id, name: tc.name, result }
        onEvent?.(resultEvent)
        yield { content: '', toolEvent: resultEvent }
        // 记录工具执行结果（成功/失败）
        if (result.error) {
          ActionLog.error(`工具失败 ${tc.name}`, result.error)
        } else {
          ActionLog.tool(`结果 ${tc.name}`, result.result)
        }

        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result.result ?? result.error ?? null),
        })
      }
      // 继续循环，让模型消费工具结果
      continue
    }

    // 无工具调用 → 最终回答（空正文守卫：思考型模型耗尽 max_tokens 时 content 为空，
    // 若静默 yield 空串，UI 会呈现"气泡空白且无报错"）
    if (!content.trim()) {
      const hint =
        resp.finishReason === 'length'
          ? '模型把 max_tokens 全部用于内部思考，未产出正文。建议调大该 Agent 的 max_tokens，或更换模型（如 deepseek-chat）。'
          : '模型返回了空正文，请重试；若持续出现请更换模型。'
      yield { content: `\n[空回复] ${hint}`, done: true, usage }
      return
    }
    history.push({ role: 'assistant', content })
    const msgEvent: AgentLoopEvent = { type: 'message', content }
    onEvent?.(msgEvent)
    yield { content, toolEvent: msgEvent }
    yield { content: '', done: true, usage }
    return
  }

  yield { content: '\n[已达工具调用上限，自动停止]', done: true }
}
