import { describe, it, expect } from 'vitest'
import { buildContextStringFromBundle } from '../context-assembler'
import type { ContextBundle, SceneCard } from '@shared/types'

function scene(overrides: Partial<SceneCard>): SceneCard {
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

function bundle(sceneCards: SceneCard[]): ContextBundle {
  return {
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
    outline: '',
    currentChapter: { title: '第一章', order: 1, hooks: ['夺回玉佩'] },
    adjacentChapters: {},
    characters: [],
    charactersText: '',
    worldviews: [],
    worldviewsText: '',
    forces: [],
    forcesText: '',
    foreshadowView: '',
    trackingStateCard: '',
    sceneCards,
    ragContext: '',
    navigationContext: '',
    previousMessages: [],
  }
}

describe('场景卡上下文注入', () => {
  it('把施工图字段写进提示词', () => {
    const text = buildContextStringFromBundle(
      bundle([
        scene({
          title: '夜探祠堂',
          goal: '夺回玉佩',
          obstacle: '守卫巡逻',
          turn: '发现密道',
          outcome: '玉佩碎裂',
          emotionBefore: '紧张',
          emotionAfter: '震惊',
          characters: ['林川'],
          hooks: ['夺回玉佩'],
          status: 'written',
        }),
      ]),
    )
    expect(text).toContain('## 本章场景卡（施工图，按顺序逐场落实）')
    expect(text).toContain('第1场《夜探祠堂》[已写]')
    expect(text).toContain('目标：夺回玉佩')
    expect(text).toContain('转折：发现密道')
    expect(text).toContain('情绪：紧张 → 震惊')
    expect(text).toContain('出场人物：林川')
  })

  it('已废弃场景不注入', () => {
    const text = buildContextStringFromBundle(
      bundle([scene({ id: 's2', title: '废稿场景', status: 'cut', goal: '不该出现' })]),
    )
    expect(text).not.toContain('本章场景卡')
    expect(text).not.toContain('废稿场景')
  })
})
