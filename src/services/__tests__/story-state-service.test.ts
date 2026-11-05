import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Character, CharacterState, Foreshadowing, PlotThread } from '@shared/types'
import {
  buildStoryStateBrief,
  computeThreadRisks,
  ensureStoryStateMigrated,
  latestCharacterStates,
  saveCharacterState,
} from '../story-state-service'

function state(id: string, characterId: string, chapterOrder: number, createdAt = '2026-11-01T00:00:00Z'): CharacterState {
  return {
    id,
    novelId: 'n1',
    characterId,
    chapterId: `c${chapterOrder}`,
    chapterOrder,
    location: '',
    knowledge: { knows: [], suspects: [], unaware: [] },
    items: [],
    abilities: [],
    relationships: [],
    status: 'active',
    note: '',
    createdAt,
  }
}

function thread(patch: Partial<PlotThread>): PlotThread {
  return {
    id: 't1',
    novelId: 'n1',
    title: '主线',
    kind: 'main',
    status: 'open',
    urgency: 5,
    payoffPlan: '',
    foreshadowingIds: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  }
}

function electron() {
  return (globalThis as any).window.electronAPI as {
    file: { exists: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> }
    db: { query: ReturnType<typeof vi.fn> }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        exists: vi.fn().mockResolvedValue(false),
        read: vi.fn().mockResolvedValue(''),
      },
      db: { query: vi.fn().mockResolvedValue([]) },
    },
  }
})

describe('latestCharacterStates', () => {
  it('每个角色取最新章节状态，同章取后创建的', () => {
    const states = [
      state('s1', 'char1', 3),
      state('s2', 'char1', 5, '2026-11-01T00:00:00Z'),
      state('s3', 'char1', 5, '2026-11-02T00:00:00Z'),
      state('s4', 'char2', 4),
    ]
    const latest = latestCharacterStates(states)
    const byId = Object.fromEntries(latest.map((s) => [s.characterId, s.id]))
    expect(byId).toEqual({ char1: 's3', char2: 's4' })
  })

  it('给定章序只取该章及之前的快照', () => {
    const latest = latestCharacterStates([state('s1', 'char1', 3), state('s2', 'char1', 5)], 4)
    expect(latest.map((s) => s.id)).toEqual(['s1'])
  })
})

describe('computeThreadRisks', () => {
  it('主线计划回收章已过 → critical', () => {
    const risks = computeThreadRisks([thread({ plannedResolveChapter: 10, lastTouchedChapter: 11 })], 12)
    expect(risks).toHaveLength(1)
    expect(risks[0].severity).toBe('critical')
    expect(risks[0].reasons.join()).toContain('逾期 2 章')
  })

  it('支线逾期与长期未推进只报 warning', () => {
    const risks = computeThreadRisks(
      [thread({ kind: 'sub', plannedResolveChapter: 5, plantedChapter: 1, lastTouchedChapter: 1 })],
      25
    )
    expect(risks[0].severity).toBe('warning')
    expect(risks[0].reasons.length).toBeGreaterThanOrEqual(2)
  })

  it('已回收/放弃的线程不参与风险计算', () => {
    expect(computeThreadRisks([thread({ status: 'resolved', plannedResolveChapter: 1 })], 50)).toEqual([])
    expect(computeThreadRisks([thread({ status: 'abandoned', plannedResolveChapter: 1 })], 50)).toEqual([])
  })
})

describe('ensureStoryStateMigrated', () => {
  const characters: Character[] = [
    {
      id: 'char1',
      novelId: 'n1',
      name: '林夕',
      role: 'protagonist',
      profile: '',
      dynamicState: '断臂后隐居',
    },
    {
      id: 'char2',
      novelId: 'n1',
      name: '路人',
      role: 'functional',
      profile: '',
      dynamicState: '',
    },
  ]
  const foreshadowings: Foreshadowing[] = [
    {
      id: 'fs1',
      novelId: 'n1',
      content: '玉佩来历',
      plantedChapter: 2,
      plannedResolveChapter: 20,
      status: 'planted',
      importance: 'major',
    },
  ]

  it('按确定性 id 写入三张表，空动态人设不迁移', async () => {
    const result = await ensureStoryStateMigrated('n1', {
      characters,
      foreshadowings,
      currentChapterOrder: 7,
    })

    expect(result).toEqual({ characterStates: 1, timelineEvents: 0, plotThreads: 1 })

    const calls = electron().db.query.mock.calls as [string, unknown[]][]
    const charInsert = calls.find(([sql]) => sql.includes('INSERT OR IGNORE INTO character_states'))
    expect(charInsert?.[0]).toContain('INSERT OR IGNORE')
    expect(charInsert?.[1]).toContain('cs_mig_char1')
    expect(charInsert?.[1]).toContain(7)

    const threadInsert = calls.find(([sql]) => sql.includes('INSERT OR IGNORE INTO plot_threads'))
    expect(threadInsert?.[1]).toContain('pt_fs_fs1')
    expect(threadInsert?.[1]).toContain(3)
  })

  it('重复执行使用同一批 id（写入层 INSERT OR IGNORE 保证幂等）', async () => {
    await ensureStoryStateMigrated('n1', { characters, foreshadowings, currentChapterOrder: 7 })
    await ensureStoryStateMigrated('n1', { characters, foreshadowings, currentChapterOrder: 9 })

    const calls = electron().db.query.mock.calls as [string, unknown[]][]
    const ids = calls
      .filter(([sql]) => sql.includes('INSERT OR IGNORE'))
      .map(([, params]) => params[0])
    expect(ids).toEqual([
      'cs_mig_char1',
      'pt_fs_fs1',
      'cs_mig_char1',
      'pt_fs_fs1',
    ])
  })

  it('作者时间线从追踪文件迁移，source=author', async () => {
    electron().file.exists.mockResolvedValue(true)
    electron().file.read.mockResolvedValue(
      JSON.stringify({ timelineAuthor: [{ chapter: 1, event: '出发' }, { chapter: 3, event: '抵达' }] })
    )

    const result = await ensureStoryStateMigrated('n1', { characters: [], foreshadowings: [] })
    expect(result.timelineEvents).toBe(2)

    const calls = electron().db.query.mock.calls as [string, unknown[]][]
    const inserts = calls.filter(([sql]) => sql.includes('INSERT OR IGNORE INTO timeline_events'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0][1]).toContain('tl_mig_n1_1_0')
    expect(inserts[0][0]).toContain("'author'")
  })

  it('追踪文件损坏时不影响角色与剧情线迁移', async () => {
    electron().file.exists.mockResolvedValue(true)
    electron().file.read.mockResolvedValue('{not json')

    const result = await ensureStoryStateMigrated('n1', {
      characters,
      foreshadowings,
      currentChapterOrder: 7,
    })
    expect(result.characterStates).toBe(1)
    expect(result.plotThreads).toBe(1)
  })
})

describe('buildStoryStateBrief', () => {
  it('只取当前章及之前的状态与时间线，未来信息不泄漏', () => {
    const brief = buildStoryStateBrief({
      states: [
        { ...state('s1', 'char1', 3), location: '山门', items: [{ name: '玉佩' }] },
        { ...state('s2', 'char1', 9), location: '地宫', status: 'dead' },
      ],
      events: [
        { id: 'e1', novelId: 'n1', chapterId: 'c1', chapterOrder: 1, storyTime: '第3天', event: '出发', location: '山门', characters: [], kind: 'plot', source: 'author', createdAt: '' },
        { id: 'e2', novelId: 'n1', chapterId: 'c9', chapterOrder: 9, storyTime: '第20天', event: '死亡', location: '地宫', characters: [], kind: 'plot', source: 'author', createdAt: '' },
      ],
      threads: [
        thread({ id: 't1', title: '玉佩身世', kind: 'main', plannedResolveChapter: 20 }),
        thread({ id: 't2', title: '已回收线', status: 'resolved' }),
      ],
      chapterOrder: 4,
      names: { char1: '林夕' },
    })

    expect(brief).toContain('林夕')
    expect(brief).toContain('山门')
    expect(brief).not.toContain('地宫')
    expect(brief).not.toContain('死亡')
    expect(brief).toContain('第3天')
    expect(brief).not.toContain('第20天')
    expect(brief).toContain('玉佩身世')
    expect(brief).not.toContain('已回收线')
  })

  it('无数据时返回空字符串', () => {
    expect(buildStoryStateBrief({ states: [], events: [], threads: [], chapterOrder: 1, names: {} })).toBe('')
  })
})

describe('saveCharacterState', () => {
  it('JSON 字段序列化后写入，保留传入 id', async () => {
    await saveCharacterState({
      id: 's1',
      novelId: 'n1',
      characterId: 'char1',
      chapterId: 'c1',
      chapterOrder: 1,
      location: '山门',
      knowledge: { knows: ['玉佩'], suspects: [], unaware: ['身世'] },
      items: [{ name: '玉佩', acquiredChapter: 1 }],
      abilities: [],
      relationships: [],
      status: 'active',
      note: '',
      createdAt: '2026-11-01T00:00:00Z',
    })

    const [sql, params] = electron().db.query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('ON CONFLICT(id) DO UPDATE')
    expect(params[0]).toBe('s1')
    expect(params[6]).toBe(JSON.stringify({ knows: ['玉佩'], suspects: [], unaware: ['身世'] }))
  })
})
