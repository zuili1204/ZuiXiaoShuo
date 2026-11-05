import { describe, expect, it } from 'vitest'
import { checkAnchors, extractAnchors } from '../anchor-check'

describe('extractAnchors', () => {
  it('提取引号内片段作为锚点', () => {
    const hooks = ['苏禾被男生表白，她必须说出「你是谁。」', '操场戏：江砚被堵']
    expect(extractAnchors(hooks)).toContain('你是谁。')
  })

  it('无引号的 hook 取整条（≥6 个汉字）', () => {
    const hooks = ['苏禾的钥匙挂在江砚的书包上']
    expect(extractAnchors(hooks)).toEqual(['苏禾的钥匙挂在江砚的书包上'])
  })

  it('过短的无引号 hook 不作为锚点（防误报）', () => {
    expect(extractAnchors(['吃饭'])).toEqual([])
  })

  it('去重', () => {
    const anchors = extractAnchors(['「你是谁。」出现两次要求：「你是谁。」'])
    expect(anchors.filter((a) => a === '你是谁。')).toHaveLength(1)
  })
})

describe('checkAnchors', () => {
  it('全部命中 → missed 为空', () => {
    const content = '苏禾盯着他，一字一顿：“你是谁？”'
    const r = checkAnchors(content, ['苏禾必须说出「你是谁。」'])
    expect(r.missed).toEqual([])
    expect(r.hit).toContain('你是谁。')
  })

  it('台词标点差异不误报（。vs ？）', () => {
    const content = '“你是谁？”她问。'
    const r = checkAnchors(content, ['必须说「你是谁。」'])
    expect(r.missed).toEqual([])
  })

  it('未命中 → missed 包含锚点', () => {
    const content = '他们聊起了天气。'
    const r = checkAnchors(content, ['苏禾必须说出「你是谁。」'])
    expect(r.missed).toHaveLength(1)
  })

  it('空 hooks → 双空', () => {
    expect(checkAnchors('任意正文', [])).toEqual({ hit: [], missed: [] })
  })
})
