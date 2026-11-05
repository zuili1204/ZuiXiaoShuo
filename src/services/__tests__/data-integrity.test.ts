import { describe, it, expect, beforeEach, vi } from 'vitest'
import { verifyChapterIntegrity, repairChapterWordCount, markChapterMissing } from '../data-service'

const rows = [
  {
    id: 'c-ok', volume_id: 'v1', title: '正常章', order_num: 1,
    content_path: 'content/n1/c-ok.md', word_count: 5, target_word_count: 3000,
    status: 'draft', hooks: '[]', summary: '',
    created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z',
  },
  {
    id: 'c-missing', volume_id: 'v1', title: '丢失章', order_num: 2,
    content_path: 'content/n1/c-missing.md', word_count: 1200, target_word_count: 3000,
    status: 'final', hooks: '[]', summary: '',
    created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z',
  },
  {
    id: 'c-mismatch', volume_id: 'v1', title: '字数不符章', order_num: 3,
    content_path: 'content/n1/c-mismatch.md', word_count: 10, target_word_count: 3000,
    status: 'draft', hooks: '[]', summary: '',
    created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z',
  },
]

function electron() {
  return (globalThis as any).window.electronAPI as {
    file: { read: ReturnType<typeof vi.fn> }
    db: { query: ReturnType<typeof vi.fn> }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        read: vi.fn(async (path: string) => {
          if (path.endsWith('c-ok.md')) return '一二三四五'
          if (path.endsWith('c-mismatch.md')) return '一二三四五六七八'
          throw new Error('ENOENT')
        }),
      },
      db: {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql.includes('FROM volumes')) return [{ id: 'v1', novel_id: 'n1' }]
          if (sql.includes('FROM chapters WHERE volume_id')) return rows
          if (sql.includes('SELECT * FROM chapters WHERE id')) {
            const id = params?.[0]
            return rows.filter((r) => r.id === id)
          }
          return []
        }),
      },
    },
  }
})

describe('章节完整性自检', () => {
  it('区分正文缺失与字数不一致，正常章不报', async () => {
    const issues = await verifyChapterIntegrity('n1')
    expect(issues.map((i) => [i.chapterId, i.kind])).toEqual([
      ['c-missing', 'missing'],
      ['c-mismatch', 'mismatch'],
    ])
  })

  it('以正文回填字数', async () => {
    const result = await repairChapterWordCount('c-mismatch')
    expect(result).toEqual({ ok: true, wordCount: 8 })
    expect(electron().db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE chapters SET word_count'),
      [8, expect.any(String), 'c-mismatch']
    )
  })

  it('标记缺失：字数清零并退回草稿', async () => {
    await markChapterMissing('c-missing')
    expect(electron().db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'draft'"),
      [expect.any(String), 'c-missing']
    )
  })
})
