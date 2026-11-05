import { describe, it, expect } from 'vitest'
import {
  buildContextStringFromBundle,
  estimateTokens,
  planContextBundle,
  trimHistoryForPlan,
} from '../context-assembler'
import type { ContextBundle, ContextPlan, SceneCard } from '@shared/types'

function scene(overrides: Partial<SceneCard> = {}): SceneCard {
  return {
    id: 's1',
    chapterId: 'c1',
    novelId: 'n1',
    orderNum: 1,
    title: '开场',
    goal: '',
    obstacle: '',
    turn: '',
    outcome: '',
    emotionBefore: '',
    emotionAfter: '',
    location: '',
    storyTime: '',
    characters: [],
    props: [],
    hooks: [],
    status: 'planned',
    wordTarget: 800,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function bundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  const base: ContextBundle = {
    novelId: 'n1',
    summary: {
      novelTitle: '测试书',
      novelDescription: '',
      genre: ['玄幻'],
      targetPlatform: '',
      totalChapters: 1,
      totalWordCount: 0,
      committedChapters: 0,
      activeForeshadowings: 0,
      characters: 0,
    },
    novel: { title: '测试书', description: '', genre: ['玄幻'], targetPlatform: '' },
    outline: '第一卷：开端',
    currentChapter: { title: '第一章', order: 1, hooks: ['夺回玉佩'], content: '' },
    adjacentChapters: {},
    characters: [],
    charactersText: '',
    worldviews: [],
    worldviewsText: '',
    forces: [],
    forcesText: '',
    foreshadowView: '',
    trackingStateCard: '',
    sceneCards: [],
    ragContext: '',
    navigationContext: '',
    previousMessages: [],
  }
  return { ...base, ...overrides }
}

describe('estimateTokens', () => {
  it('中文按 1.5、英文按 4 字符估算', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('中文四个')).toBe(6)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('planContextBundle', () => {
  it('预算不足时先裁当前章旧正文，保住场景卡', () => {
    const b = bundle({
      sceneCards: [scene({ title: '夜探祠堂', goal: '夺回玉佩' })],
      currentChapter: { title: '第一章', order: 1, hooks: ['夺回玉佩'], content: '旧稿'.repeat(4000) },
    })
    const plan = planContextBundle(b, { budgetTokens: 2000 })

    const sceneSection = plan.sections.find((s) => s.key === 'scene')!
    expect(sceneSection.included).toBe(true)
    expect(sceneSection.content).toContain('夜探祠堂')
    expect(plan.dropped.some((d) => d.key === 'current')).toBe(true)
    expect(plan.rendered?.current?.length ?? 0).toBeLessThan(2000)
  })

  it('固定当前章后不再裁剪正文，改为裁剪场景卡', () => {
    const b = bundle({
      sceneCards: [scene({ title: '夜探祠堂', goal: '夺回玉佩' })],
      currentChapter: { title: '第一章', order: 1, hooks: ['夺回玉佩'], content: '旧稿'.repeat(4000) },
    })
    const plan = planContextBundle(b, { budgetTokens: 2000, overrides: { pin: ['current'] } })

    expect(plan.rendered?.current).toContain('旧稿')
    expect(plan.dropped.some((d) => d.key === 'scene')).toBe(true)
    expect(plan.sections.find((s) => s.key === 'current')?.reason).toBe('固定：不裁剪')
  })

  it('排除的区块不注入且标明原因', () => {
    const b = bundle({
      sceneCards: [scene({ title: '夜探祠堂', goal: '夺回玉佩' })],
      ragContext: '相关资料',
    })
    const plan = planContextBundle(b, { budgetTokens: 32000, overrides: { exclude: ['rag'] } })

    const rag = plan.sections.find((s) => s.key === 'rag')!
    expect(rag.included).toBe(false)
    expect(rag.reason).toBe('用户已排除（本次不注入）')
    expect(plan.rendered?.rag).toBeUndefined()
  })

  it('安全区块始终保留，不可排除', () => {
    const plan = planContextBundle(bundle(), { overrides: { exclude: ['safety'] } })
    expect(plan.sections.find((s) => s.key === 'safety')?.included).toBe(true)
  })
})

describe('buildContextStringFromBundle（按计划渲染）', () => {
  it('只渲染入选区块，并含裁剪后的正文', () => {
    const b = bundle({
      navigationContext: '【导航】当前写到第一章',
      sceneCards: [scene({ title: '夜探祠堂', goal: '夺回玉佩' })],
      currentChapter: { title: '第一章', order: 1, hooks: ['夺回玉佩'], content: '旧稿'.repeat(4000) },
      ragContext: '检索到的资料',
    })
    const plan = planContextBundle(b, {
      budgetTokens: 2000,
      overrides: { exclude: ['scene'] },
    })
    b.contextPlan = plan
    const text = buildContextStringFromBundle(b)

    expect(text.startsWith('【导航】当前写到第一章')).toBe(true)
    expect(text).toContain('## 相关资料检索（RAG）')
    expect(text).toContain('检索到的资料')
    expect(text).not.toContain('夜探祠堂')
    expect(text).toContain('## 当前章节：第1章 《第一章》')
    expect(text.length).toBeLessThan(4000)
  })
})

describe('planContextBundle（P2 文风区块）', () => {
  const styleText = '## 文风目标（只影响表达方式）\n句长 12-18 字，多用动作代替心理描写。'

  it('绑定文风后被选入并保留原文', () => {
    const plan = planContextBundle(bundle({ styleContext: styleText }), { budgetTokens: 32000 })
    const style = plan.sections.find((s) => s.key === 'style')!

    expect(style.included).toBe(true)
    expect(style.reason).toBe('已绑定文风配方')
    expect(plan.rendered?.style).toBe(styleText)
  })

  it('用户排除后不注入且标明原因', () => {
    const plan = planContextBundle(bundle({ styleContext: styleText }), {
      budgetTokens: 32000,
      overrides: { exclude: ['style'] },
    })
    const style = plan.sections.find((s) => s.key === 'style')!

    expect(style.included).toBe(false)
    expect(style.reason).toBe('用户已排除（本次不注入）')
    expect(plan.rendered?.style).toBeUndefined()
  })

  it('未绑定文风时区块缺席', () => {
    const style = planContextBundle(bundle(), { budgetTokens: 32000 }).sections.find((s) => s.key === 'style')!
    expect(style.included).toBe(false)
    expect(style.reason).toBe('未绑定文风画像')
  })

  it('超出 5% 预算时从尾部裁剪并记录', () => {
    const longStyle = `## 文风目标（只影响表达方式）\n${'克制叙述，短句推进。'.repeat(200)}`
    const plan = planContextBundle(bundle({ styleContext: longStyle }), { budgetTokens: 2000 })
    const style = plan.sections.find((s) => s.key === 'style')!

    expect(style.included).toBe(true)
    expect(style.tokens).toBeLessThanOrEqual(100)
    expect(plan.dropped.some((d) => d.key === 'style' && d.reason.includes('文风预算'))).toBe(true)
  })

  it('按计划渲染时只拼接入选的文风文本', () => {
    const b = bundle({ styleContext: styleText })
    b.contextPlan = planContextBundle(b, { budgetTokens: 32000 })
    expect(buildContextStringFromBundle(b)).toContain('## 文风目标（只影响表达方式）')

    const excluded = bundle({ styleContext: styleText })
    excluded.contextPlan = planContextBundle(excluded, {
      budgetTokens: 32000,
      overrides: { exclude: ['style'] },
    })
    expect(buildContextStringFromBundle(excluded)).not.toContain('## 文风目标')
  })
})

describe('trimHistoryForPlan', () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `第${i}条`.repeat(400),
  }))

  it('无计划时保留最近 10 条以内', () => {
    expect(trimHistoryForPlan(messages)).toHaveLength(5)
    expect(trimHistoryForPlan([...messages, ...messages])).toHaveLength(10)
  })

  it('按历史预算从最旧开始丢，至少保留最近一条', () => {
    const plan = { historyBudgetTokens: 100 } as ContextPlan
    const kept = trimHistoryForPlan(messages, plan)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toBe(messages[messages.length - 1])
  })
})
