import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  computeHooksCoverage,
  createSceneCard,
  ensureSceneCardsForChapter,
  listSceneCards,
  updateSceneCard,
} from '../scene-service'
import type { SceneCard } from '@shared/types'

type Row = Record<string, any>
let rows: Row[] = []

function electron() {
  return (globalThis as any).window.electronAPI as {
    db: { query: ReturnType<typeof vi.fn> }
  }
}

beforeEach(() => {
  rows = []
  vi.clearAllMocks()
  ;(globalThis as any).window = {
    electronAPI: {
      db: {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT * FROM scene_cards WHERE chapter_id')) {
            return rows
              .filter((r) => r.chapter_id === params[0])
              .sort((a, b) => a.order_num - b.order_num)
          }
          if (sql.includes('COALESCE(MAX(order_num)')) {
            const matches = rows.filter((r) => r.chapter_id === params[0])
            return [{ max_order: matches.reduce((m, r) => Math.max(m, r.order_num), 0) }]
          }
          if (sql.includes('INSERT INTO scene_cards')) {
            const [
              id, chapter_id, novel_id, order_num, title, goal, obstacle, turn, outcome,
              emotion_before, emotion_after, location, story_time, characters_json,
              props_json, hooks_json, status, word_target, created_at, updated_at,
            ] = params
            rows.push({
              id, chapter_id, novel_id, order_num, title, goal, obstacle, turn, outcome,
              emotion_before, emotion_after, location, story_time, characters_json,
              props_json, hooks_json, status, word_target, created_at, updated_at,
            })
            return []
          }
          if (sql.includes('UPDATE scene_cards SET')) {
            const setClause = /SET ([\s\S]*?) WHERE/.exec(sql)
            const columns = setClause
              ? setClause[1].split(',').map((part) => part.split('=')[0].trim())
              : []
            const id = params[params.length - 1]
            const row = rows.find((r) => r.id === id)
            if (row) columns.forEach((col, i) => { row[col] = params[i] })
            return []
          }
          if (sql.includes('DELETE FROM scene_cards')) {
            rows = rows.filter((r) => r.id !== params[0])
            return []
          }
          return []
        }),
      },
    },
  }
})

describe('场景卡服务', () => {
  it('按顺序读取并解析 JSON 字段', async () => {
    rows.push({
      id: 's2', chapter_id: 'c1', novel_id: 'n1', order_num: 2,
      title: '第二场', status: 'written', word_target: 900,
      characters_json: '["甲"]', props_json: '["剑"]', hooks_json: '["钩子2"]',
      created_at: '', updated_at: '',
    })
    rows.push({
      id: 's1', chapter_id: 'c1', novel_id: 'n1', order_num: 1,
      title: '第一场', status: 'planned', word_target: 800,
      characters_json: '[]', props_json: '[]', hooks_json: '["钩子1"]',
      created_at: '', updated_at: '',
    })

    const cards = await listSceneCards('c1')
    expect(cards.map((c) => c.id)).toEqual(['s1', 's2'])
    expect(cards[1].characters).toEqual(['甲'])
    expect(cards[0].hooks).toEqual(['钩子1'])
  })

  it('创建场景卡时自动计算顺序', async () => {
    const first = await createSceneCard({ novelId: 'n1', chapterId: 'c1', title: '开场' })
    const second = await createSceneCard({ novelId: 'n1', chapterId: 'c1', title: '冲突' })
    expect([first.orderNum, second.orderNum]).toEqual([1, 2])
    expect(rows).toHaveLength(2)
  })

  it('更新场景卡写入 snake_case 列', async () => {
    const card = await createSceneCard({ novelId: 'n1', chapterId: 'c1', title: '开场' })
    await updateSceneCard(card.id, { hooks: ['钩子A'], status: 'writing' })
    const row = rows.find((r) => r.id === card.id)!
    expect(row.hooks_json).toBe('["钩子A"]')
    expect(row.status).toBe('writing')
  })

  it('hooks 覆盖率忽略 cut 卡', () => {
    const cards: SceneCard[] = [
      { hooks: ['a'] } as SceneCard,
      { hooks: ['b'], status: 'cut' } as SceneCard,
    ]
    const coverage = computeHooksCoverage(cards, ['a', 'b', 'c'])
    expect(coverage).toEqual({ total: 3, covered: 1, uncovered: ['b', 'c'], ratio: 1 / 3 })
  })

  it('有 hooks 时逐条拆卡，重复调用幂等', async () => {
    const chapter = { id: 'c1', title: '第一章', hooks: ['钩子1', '钩子2'] }
    const first = await ensureSceneCardsForChapter('n1', chapter)
    const second = await ensureSceneCardsForChapter('n1', chapter)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(rows).toHaveLength(2)
    expect(first[0].hooks).toEqual(['钩子1'])
  })

  it('无 hooks 时生成一张开场卡', async () => {
    const cards = await ensureSceneCardsForChapter('n1', { id: 'c2', hooks: [] })
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('开场')
  })
})
