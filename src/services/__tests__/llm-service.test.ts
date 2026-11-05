import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentConfig } from '@shared/types'

// Mock window.electronAPI.key
beforeEach(() => {
  ;(globalThis as any).window = {
    electronAPI: {
      key: {
        decrypt: vi.fn().mockResolvedValue('sk-test-123'),
      },
    },
  }
})

import { testConnection, streamChat, chatWithTools } from '../llm-service'

function makeAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    name: '测试',
    role: 'writer',
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 2000,
    apiKeyEncrypted: 'enc',
    systemPrompt: '',
    skillRefs: [],
    isActive: true,
    ...overrides,
  }
}

describe('LLM Service - testConnection', () => {
  it('should fail when no API key', async () => {
    ;(globalThis as any).window.electronAPI.key.decrypt = vi.fn().mockResolvedValue('')
    const res = await testConnection(makeAgent({ apiKeyEncrypted: 'enc' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('API Key')
  })

  it('should fail when custom provider has no endpoint', async () => {
    const res = await testConnection(makeAgent({ provider: 'custom', model: 'm', endpoint: '' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('接口地址')
  })

  it('should POST to custom endpoint for connectivity check', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') })
    ;(globalThis as any).fetch = fetchMock
    const res = await testConnection(
      makeAgent({ provider: 'custom', model: 'deepseek-V4-flase', endpoint: 'https://gw.example.com/v1' })
    )
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('https://gw.example.com/v1/chat/completions')
    expect(opts.headers.Authorization).toBe('Bearer sk-test-123')
  })

  it('should report non-ok status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('unauthorized') })
    ;(globalThis as any).fetch = fetchMock
    const res = await testConnection(makeAgent({ provider: 'openai', model: 'gpt-4o' }))
    expect(res.ok).toBe(false)
    expect(res.message).toContain('401')
  })
})

// ===== P2-7：错误分类 → 指数退避重试 → 跨 Provider 降级 =====

describe('LLM Service - resilience (P2-7: retry + fallback)', () => {
  const PRIMARY = 'api.openai.com'
  const FALLBACK = 'api.deepseek.com'

  // 模拟 SSE OK 响应：body 为 ReadableStream，逐块输出 content
  function sseOk(contents: string[]) {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const t of contents) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`))
        }
        c.close()
      },
    })
    return { ok: true, status: 200, text: () => Promise.resolve(''), body: stream }
  }

  function httpErr(status: number, msg: string) {
    return { ok: false, status, text: () => Promise.resolve(JSON.stringify({ error: { message: msg } })) }
  }

  // agentConfigService.getAll() 背后的 DB 行（snake_case）
  function fallbackDbRows() {
    return [
      {
        id: 'agent-ds',
        name: 'DS',
        role: 'writer',
        provider: 'deepseek',
        model: 'deepseek-chat',
        temperature: 0.7,
        max_tokens: 100,
        api_key_encrypted: 'enc-ds',
        system_prompt: '',
        skill_refs: '[]',
        is_active: 1,
        created_at: '2026-01-01',
      },
    ]
  }

  function setDb(rows: unknown[]) {
    ;(globalThis as any).window.electronAPI.db = { query: vi.fn().mockResolvedValue(rows) }
  }

  async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
    const out: unknown[] = []
    for await (const c of gen) out.push(c)
    return out
  }

  it('retries retryable network errors then succeeds (no fallback)', async () => {
    setDb([])
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(sseOk(['你好']))
    ;(globalThis as any).fetch = fetchMock
    const chunks = await collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 2, baseDelayMs: 1 }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(chunks.some((c: any) => c.content === '你好')).toBe(true)
    expect(chunks.some((c: any) => c.fallback)).toBe(false)
  })

  it('falls back to configured provider after retries exhausted, yields fallback event first', async () => {
    setDb(fallbackDbRows())
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes(PRIMARY) ? Promise.reject(new TypeError('fetch failed')) : sseOk(['fallback-ok'])
    )
    ;(globalThis as any).fetch = fetchMock
    const chunks = await collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 1, baseDelayMs: 1 }))
    const primaryCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes(PRIMARY)).length
    const fallbackCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes(FALLBACK)).length
    expect(primaryCalls).toBe(2) // 1 次原始 + 1 次重试
    expect(fallbackCalls).toBe(1)
    const first = chunks[0] as any
    expect(first.fallback).toEqual({ from: 'openai', to: 'deepseek', reason: '网络连接失败' })
    expect(chunks.some((c: any) => c.content === 'fallback-ok')).toBe(true)
  })

  it('does not retry non-retryable errors (401) but falls back immediately', async () => {
    setDb(fallbackDbRows())
    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes(PRIMARY) ? httpErr(401, 'unauthorized-primary') : sseOk(['ok'])
    )
    ;(globalThis as any).fetch = fetchMock
    const chunks = await collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 2, baseDelayMs: 1 }))
    const primaryCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes(PRIMARY)).length
    expect(primaryCalls).toBe(1) // 401 不可重试，主配置只调一次
    expect((chunks[0] as any).fallback?.to).toBe('deepseek')
  })

  it('throws original error when no fallback agent is configured', async () => {
    setDb([])
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(httpErr(401, 'unauthorized-primary'))
    const run = async () => collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 1, baseDelayMs: 1 }))
    await expect(run()).rejects.toThrow('unauthorized-primary')
  })

  it('throws original error when fallback also fails', async () => {
    setDb(fallbackDbRows())
    ;(globalThis as any).fetch = vi.fn().mockImplementation(async (url: string) =>
      String(url).includes(PRIMARY) ? httpErr(401, 'unauthorized-primary') : httpErr(401, 'unauthorized-fallback')
    )
    const run = async () => collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 1, baseDelayMs: 1 }))
    await expect(run()).rejects.toThrow('unauthorized-primary')
  })

  it('does not retry user aborts', async () => {
    setDb([])
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' })
    const fetchMock = vi.fn().mockRejectedValue(abortErr)
    ;(globalThis as any).fetch = fetchMock
    const run = async () => collect(streamChat(makeAgent({}), [{ role: 'user', content: 'hi' }], undefined, { attempts: 2, baseDelayMs: 1 }))
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('chatWithTools retries then succeeds', async () => {
    setDb([])
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'done' } }] }),
      })
    ;(globalThis as any).fetch = fetchMock
    const res = await chatWithTools(
      makeAgent({}),
      [{ role: 'user', content: 'x' }],
      [{ type: 'function', function: { name: 't', description: '', parameters: {} } }],
      undefined,
      { attempts: 2, baseDelayMs: 1 }
    )
    expect(res.content).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// ===== 思考型模型空回复防护（q23 诊断：deepseek-flash 将 reasoning 计入 max_tokens） =====

describe('LLM Service - thinking disable + finishReason', () => {
  function setFetch(res: unknown) {
    ;(globalThis as any).window.electronAPI.db = { query: vi.fn().mockResolvedValue([]) }
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue(res)
  }

  function jsonRes(body: unknown) {
    return { ok: true, status: 200, json: () => Promise.resolve(body) }
  }

  it('deepseek writer/polisher 请求体携带 thinking disabled', async () => {
    setFetch(jsonRes({ choices: [{ message: { content: 'ok' } }] }))
    await chatWithTools(makeAgent({ provider: 'deepseek', model: 'deepseek-flash', role: 'writer' }), [], [])
    const body = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('deepseek polisher 同样关闭思考', async () => {
    setFetch(jsonRes({ choices: [{ message: { content: 'ok' } }] }))
    await chatWithTools(makeAgent({ provider: 'deepseek', model: 'deepseek-v4-flash', role: 'polisher' }), [], [])
    const body = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body)
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('deepseek 分析类角色（architect）不附加 thinking 参数', async () => {
    setFetch(jsonRes({ choices: [{ message: { content: 'ok' } }] }))
    await chatWithTools(makeAgent({ provider: 'deepseek', model: 'deepseek-flash', role: 'architect' }), [], [])
    const body = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
  })

  it('非 deepseek provider 不附加 thinking 参数', async () => {
    setFetch(jsonRes({ choices: [{ message: { content: 'ok' } }] }))
    await chatWithTools(makeAgent({ provider: 'openai', role: 'writer' }), [], [])
    const body = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
  })

  it('chatWithTools 返回 finishReason（识别思考耗尽 finish=length）', async () => {
    setFetch(
      jsonRes({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      })
    )
    const res = await chatWithTools(makeAgent({ provider: 'deepseek', model: 'deepseek-flash', role: 'writer' }), [], [])
    expect(res.content).toBe('')
    expect(res.finishReason).toBe('length')
  })

  it('streamChat 捕获 choices 块上的 finish_reason 并在 done 块透出', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ' hi' }, finish_reason: null }] })}\n\n`))
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`))
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`))
        c.close()
      },
    })
    setFetch({ ok: true, status: 200, text: () => Promise.resolve(''), body: stream })
    const chunks: any[] = []
    for await (const c of streamChat(makeAgent({ provider: 'deepseek', model: 'deepseek-chat', role: 'writer' }), [{ role: 'user', content: 'hi' }])) {
      chunks.push(c)
    }
    expect(chunks.some((c) => c.content === ' hi')).toBe(true)
    const done = chunks.find((c) => c.done)
    expect(done.finishReason).toBe('length')
    expect(done.usage).toEqual({ inputTokens: 5, outputTokens: 2, model: 'deepseek-chat' })
  })

  it('streamChat 空流时最终 done 块仍携带 finishReason', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考中' }, finish_reason: null }] })}\n\n`))
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`))
        c.close()
      },
    })
    setFetch({ ok: true, status: 200, text: () => Promise.resolve(''), body: stream })
    const chunks: any[] = []
    for await (const c of streamChat(makeAgent({ provider: 'deepseek', model: 'deepseek-flash', role: 'writer' }), [{ role: 'user', content: 'hi' }])) {
      chunks.push(c)
    }
    const done = chunks.find((c) => c.done)
    expect(done.finishReason).toBe('length')
    expect(chunks.some((c) => c.content)).toBe(false)
  })
})
