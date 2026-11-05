import { describe, it, expect, beforeEach } from 'vitest'
import {
  commitTrackingState,
  createDefaultState,
  loadTrackingState,
} from '../tracking-service'

let files: Record<string, string> = {}

beforeEach(() => {
  files = {}
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        exists: async (path: string) => path in files,
        read: async (path: string) => files[path],
        write: async (path: string, content: string) => { files[path] = content },
      },
    },
  }
})

function pathOf(novelId: string) {
  return `content/tracking/${novelId}.json`
}

describe('状态事务', () => {
  it('提交成功后 revision +1、去重并追加事务日志', async () => {
    const res = await commitTrackingState(
      'tx-a',
      { longTermConstraints: ['约束A', '约束A', '约束B'] },
      { expectedRevision: 1, source: 'manual' },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.state.revision).toBe(2)
    expect(res.state.longTermConstraints).toEqual(['约束A', '约束B'])
    expect(res.state.transactions).toHaveLength(1)
    expect(res.state.transactions?.[0]).toMatchObject({
      expectedRevision: 1,
      revision: 2,
      source: 'manual',
    })
    expect(files[pathOf('tx-a')]).toContain('约束A')
  })

  it('旧 revision 提交被拒绝，且不写盘', async () => {
    await commitTrackingState('tx-b', { longTermConstraints: ['A'] }, { expectedRevision: 1, source: 'manual' })
    const before = files[pathOf('tx-b')]

    const res = await commitTrackingState('tx-b', { longTermConstraints: ['B'] }, { expectedRevision: 1, source: 'manual' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.conflict).toBe(true)
    expect(res.currentRevision).toBe(2)
    expect(res.state.longTermConstraints).toEqual(['A'])
    expect(files[pathOf('tx-b')]).toBe(before)
  })

  it('retiredItems 移除不再成立的条目', async () => {
    const seed = {
      ...createDefaultState('tx-c'),
      revision: 3,
      longTermConstraints: ['约束A', '约束B'],
      coherenceRisks: ['风险X'],
      nextChapterPromises: ['承诺Y'],
    }
    files[pathOf('tx-c')] = JSON.stringify(seed)

    const res = await commitTrackingState(
      'tx-c',
      {
        retiredItems: [
          { kind: 'constraint', content: '约束A' },
          { kind: 'risk', content: '风险X' },
        ],
      },
      { expectedRevision: 3, source: 'ai' },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.state.revision).toBe(4)
    expect(res.state.longTermConstraints).toEqual(['约束B'])
    expect(res.state.coherenceRisks).toEqual([])
    expect(res.state.nextChapterPromises).toEqual(['承诺Y'])
    expect(res.state.transactions?.[0].retiredItems).toHaveLength(2)
  })

  it('长期约束最多保留 6 条', async () => {
    const res = await commitTrackingState(
      'tx-d',
      { longTermConstraints: ['1', '2', '3', '4', '5', '6', '7'] },
      { expectedRevision: 1, source: 'manual' },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.state.longTermConstraints).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('事务日志最多保留 50 条', async () => {
    let state = createDefaultState('tx-e')
    files[pathOf('tx-e')] = JSON.stringify({ ...state, transactions: [] })
    for (let i = 0; i < 55; i++) {
      const res = await commitTrackingState(
        'tx-e',
        { coherenceRisks: [`风险${i}`] },
        { expectedRevision: state.revision, source: 'manual' },
      )
      expect(res.ok).toBe(true)
      if (!res.ok) return
      state = res.state
    }
    const loaded = await loadTrackingState('tx-e')
    expect(loaded.transactions).toHaveLength(50)
    expect(loaded.revision).toBe(56)
  })
})
