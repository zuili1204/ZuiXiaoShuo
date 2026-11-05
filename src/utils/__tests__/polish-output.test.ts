import { describe, it, expect } from 'vitest'
import { extractPolishedBody } from '../polish-output'

const longBody = (n = 300) => '他推开门，屋里没人。'.repeat(Math.ceil(n / 10))

describe('extractPolishedBody', () => {
  it('结构化标记优先：提取最后一对标记内的全文', () => {
    const body = longBody()
    const raw = `## 去AI味润色报告\n\n### 字数协议\n- 原文字符数：6300\n\n<<<POLISHED-BEGIN>>>\n${body}\n<<<POLISHED-END>>>`
    const r = extractPolishedBody(raw)
    expect(r).not.toBeNull()
    expect(r!.hadReport).toBe(true)
    expect(r!.text).toBe(body)
  })

  it('无标记：取最后一处「润色后全文」标题之后的内容并剥离代码围栏', () => {
    const body = longBody()
    const raw = `## 去AI味润色报告\n\n### 字数协议\n- 净变化：-0.8%\n\n### 润色后全文（关键改动段落）\n\`\`\`\n${body}\n\`\`\``
    const r = extractPolishedBody(raw)
    expect(r).not.toBeNull()
    expect(r!.hadReport).toBe(true)
    expect(r!.text).toBe(body)
  })

  it('纯正文（无报告）原样通过', () => {
    const body = longBody()
    const r = extractPolishedBody(body)
    expect(r).not.toBeNull()
    expect(r!.hadReport).toBe(false)
    expect(r!.text).toBe(body)
  })

  it('只有报告没有全文（生成被截断）→ 拒绝', () => {
    const raw = `## 去AI味润色报告\n\n### 字数协议\n- 原文字符数：约 6300\n- AI味等级：轻度\n`
    expect(extractPolishedBody(raw)).toBeNull()
  })

  it('提取结果中混入报告残留 → 拒绝', () => {
    const raw = `### 润色后全文\n${longBody()}\n## 去AI味润色报告\n### 字数协议`
    expect(extractPolishedBody(raw)).toBeNull()
  })

  it('正文过短 → 拒绝', () => {
    expect(extractPolishedBody('太短了。')).toBeNull()
    expect(extractPolishedBody('')).toBeNull()
  })

  it('minLen 可调', () => {
    const short = '他推开门，屋里没人。他推开门，屋里没人。他推开门，屋里没人。'
    expect(extractPolishedBody(short, 20)).not.toBeNull()
    expect(extractPolishedBody(short, 200)).toBeNull()
  })
})
