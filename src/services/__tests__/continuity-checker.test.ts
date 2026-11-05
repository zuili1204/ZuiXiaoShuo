import { describe, it, expect } from 'vitest'
import type { CharacterState, PlotThread, SceneCard, TimelineEvent } from '@shared/types'
import {
  parseStoryTime,
  runContinuityCheck,
  summarizeContinuity,
  type ContinuityCheckInput,
} from '../continuity-checker'

function state(patch: Partial<CharacterState> & { id: string; characterId: string; chapterOrder: number }): CharacterState {
  return {
    novelId: 'n1',
    chapterId: `c${patch.chapterOrder}`,
    location: '',
    knowledge: { knows: [], suspects: [], unaware: [] },
    items: [],
    abilities: [],
    relationships: [],
    status: 'active',
    note: '',
    createdAt: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function event(patch: Partial<TimelineEvent> & { id: string; chapterOrder: number }): TimelineEvent {
  return {
    novelId: 'n1',
    chapterId: `c${patch.chapterOrder}`,
    storyTime: '',
    event: '',
    location: '',
    characters: [],
    kind: 'plot',
    source: 'author',
    createdAt: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function thread(patch: Partial<PlotThread> & { id: string }): PlotThread {
  return {
    novelId: 'n1',
    title: '线程',
    kind: 'sub',
    status: 'open',
    urgency: 1,
    payoffPlan: '',
    foreshadowingIds: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function card(patch: Partial<SceneCard> & { id: string }): SceneCard {
  return {
    chapterId: 'c1',
    novelId: 'n1',
    orderNum: 1,
    title: '',
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
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function run(input: Partial<ContinuityCheckInput>): ReturnType<typeof runContinuityCheck> {
  return runContinuityCheck({
    chapterOrder: 4,
    content: '',
    characterStates: [],
    ...input,
  })
}

describe('parseStoryTime', () => {
  it('识别第N天 / 日期 / 时刻，未知格式返回 null', () => {
    expect(parseStoryTime('第12天')).toEqual({ unit: 'day', value: 12 })
    expect(parseStoryTime('2026年5月1日 08:30')?.unit).toBe('date')
    expect(parseStoryTime('2026-05-01')?.unit).toBe('date')
    expect(parseStoryTime('5月1日')?.unit).toBe('date')
    expect(parseStoryTime('08:30')).toEqual({ unit: 'clock', value: 510 })
    expect(parseStoryTime('黄昏')).toBeNull()
  })
})

describe('runContinuityCheck — 4 条 blocking', () => {
  it('死者出场：死亡章之后再次出现 → blocking', () => {
    const findings = run({
      content: '林夕推门而入，脸色苍白。',
      characterStates: [state({ id: 's1', characterId: 'char1', chapterOrder: 3, status: 'dead' })],
      characterNamesById: { char1: '林夕' },
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ ruleId: 'dead-character', severity: 'blocking' })
    expect(findings[0].evidence).toContain('林夕')
  })

  it('死亡当章与死亡前的章节不报', () => {
    const deadSameChapter = run({
      chapterOrder: 3,
      content: '林夕倒下。',
      characterStates: [state({ id: 's1', characterId: 'char1', chapterOrder: 3, status: 'dead' })],
      characterNamesById: { char1: '林夕' },
    })
    expect(deadSameChapter).toEqual([])

    const beforeDeath = run({
      chapterOrder: 2,
      content: '林夕笑了。',
      characterStates: [
        state({ id: 's1', characterId: 'char1', chapterOrder: 2, status: 'active' }),
        state({ id: 's2', characterId: 'char1', chapterOrder: 5, status: 'dead' }),
      ],
      characterNamesById: { char1: '林夕' },
    })
    expect(beforeDeath).toEqual([])
  })

  it('物品提前：本章使用了尚未获得的物品 → blocking', () => {
    const findings = run({
      content: '他握紧玄铁令，缓步走进大殿。',
      characterStates: [
        state({
          id: 's1',
          characterId: 'char1',
          chapterOrder: 2,
          items: [{ name: '玄铁令', acquiredChapter: 5 }],
        }),
      ],
    })
    expect(findings[0]).toMatchObject({ ruleId: 'item-early', severity: 'blocking' })
  })

  it('能力提前：本章使用了尚未解锁的能力 → blocking', () => {
    const findings = run({
      content: '他一掌拍出，天雷掌轰落。',
      characterStates: [
        state({
          id: 's1',
          characterId: 'char1',
          chapterOrder: 2,
          abilities: [{ name: '天雷掌', unlockedChapter: 6 }],
        }),
      ],
    })
    expect(findings[0]).toMatchObject({ ruleId: 'ability-early', severity: 'blocking' })
  })

  it('时间倒流：本章故事时间早于上一章 → blocking', () => {
    const findings = run({
      chapterOrder: 2,
      timelineEvents: [
        event({ id: 'e1', chapterOrder: 1, storyTime: '第10天' }),
        event({ id: 'e2', chapterOrder: 2, storyTime: '第8天' }),
      ],
    })
    expect(findings[0]).toMatchObject({ ruleId: 'time-reversal', severity: 'blocking' })
  })

  it('时间写法无法解析时不做判断（不误杀）', () => {
    const findings = run({
      chapterOrder: 2,
      timelineEvents: [
        event({ id: 'e1', chapterOrder: 1, storyTime: '黄昏' }),
        event({ id: 'e2', chapterOrder: 2, storyTime: '清晨' }),
      ],
    })
    expect(findings.filter((f) => f.ruleId === 'time-reversal')).toEqual([])
  })
})

describe('runContinuityCheck — warnings', () => {
  it('同刻两地 → warning', () => {
    const findings = run({
      chapterOrder: 3,
      timelineEvents: [
        event({ id: 'e1', chapterOrder: 3, storyTime: '第5天', location: '客栈', characters: ['林夕'] }),
        event({ id: 'e2', chapterOrder: 3, storyTime: '第5天', location: '山门', characters: ['林夕'] }),
      ],
    })
    expect(findings[0]).toMatchObject({ ruleId: 'dual-location', severity: 'warning' })
  })

  it('历史章节的同刻冲突不在当前章重复告警', () => {
    const findings = run({
      chapterOrder: 5,
      timelineEvents: [
        event({ id: 'e1', chapterOrder: 2, storyTime: '第5天', location: '客栈', characters: ['林夕'] }),
        event({ id: 'e2', chapterOrder: 3, storyTime: '第5天', location: '山门', characters: ['林夕'] }),
      ],
    })
    expect(findings.find((f) => f.ruleId === 'dual-location')).toBeUndefined()
  })

  it('伏笔错序 → warning', () => {
    const findings = run({
      chapterOrder: 10,
      plotThreads: [thread({ id: 't1', plantedChapter: 8, resolvedChapter: 5 })],
    })
    expect(findings.some((f) => f.ruleId === 'foreshadow-order')).toBe(true)
  })

  it('主线逾期 → warning，支线长期未推进 → warning', () => {
    const findings = run({
      chapterOrder: 30,
      plotThreads: [
        thread({ id: 't1', kind: 'main', title: '主线', plannedResolveChapter: 20, lastTouchedChapter: 29 }),
        thread({ id: 't2', kind: 'sub', title: '支线', plantedChapter: 2, lastTouchedChapter: 2 }),
      ],
    })
    expect(findings.find((f) => f.ruleId === 'main-overdue')).toBeTruthy()
    expect(findings.find((f) => f.ruleId === 'thread-stale')).toBeTruthy()
    expect(findings.every((f) => f.severity === 'warning')).toBe(true)
  })

  it('名称不一致：同一角色两种写法 → warning', () => {
    const findings = run({
      content: '林 夕与林夕儿一起走来。',
      characterNames: ['林夕', '林夕儿', '林 夕'],
    })
    expect(findings.filter((f) => f.ruleId === 'name-inconsistent').length).toBeGreaterThanOrEqual(1)
  })

  it('张三与张三丰是独立姓名，仅出现长名时不告警', () => {
    const findings = run({
      content: '张三丰独自走进山门。',
      characterNames: ['张三', '张三丰'],
    })
    expect(findings.filter((f) => f.ruleId === 'name-inconsistent')).toHaveLength(0)
  })

  it('承诺未兑现 → warning，兑现则不报', () => {
    const missing = run({ content: '他们继续赶路。', previousPromises: ['去城南找老铁匠'] })
    expect(missing[0]).toMatchObject({ ruleId: 'promise-unfulfilled', severity: 'warning' })

    const kept = run({ content: '两人来到城南，找到老铁匠。', previousPromises: ['去城南找老铁匠'] })
    expect(kept).toEqual([])
  })

  it('细纲 hooks 未被场景卡覆盖 → warning', () => {
    const findings = run({
      hooks: ['主角发现玉佩'],
      sceneCards: [card({ id: 'sc1', hooks: ['主角赶路'] })],
    })
    expect(findings[0]).toMatchObject({ ruleId: 'hooks-uncovered', severity: 'warning' })

    const covered = run({
      hooks: ['主角发现玉佩'],
      sceneCards: [card({ id: 'sc1', hooks: ['主角发现玉佩'] })],
    })
    expect(covered).toEqual([])
  })
})

describe('runContinuityCheck — 健康稿零告警', () => {
  it('状态、时间线、剧情线、场景卡全部自洽时不产生 finding', () => {
    const findings = run({
      chapterOrder: 5,
      content: '林夕取出玉佩，抬头看向山门。',
      characterStates: [
        state({
          id: 's1',
          characterId: 'char1',
          chapterOrder: 1,
          items: [{ name: '玉佩', acquiredChapter: 1 }],
        }),
      ],
      characterNames: ['林夕'],
      characterNamesById: { char1: '林夕' },
      timelineEvents: [
        event({ id: 'e1', chapterOrder: 1, storyTime: '第1天' }),
        event({ id: 'e2', chapterOrder: 5, storyTime: '第5天' }),
      ],
      plotThreads: [thread({ id: 't1', kind: 'main', plantedChapter: 1, lastTouchedChapter: 5 })],
      hooks: ['林夕发现玉佩'],
      sceneCards: [card({ id: 'sc1', hooks: ['林夕发现玉佩'] })],
    })
    expect(findings).toEqual([])
  })

  it('summarizeContinuity 统计 blocking / warning', () => {
    const report = summarizeContinuity([
      { ruleId: 'dead-character', severity: 'blocking', message: 'x' },
      { ruleId: 'dual-location', severity: 'warning', message: 'y' },
    ])
    expect(report).toMatchObject({ blocking: 1, warnings: 1 })
  })
})
