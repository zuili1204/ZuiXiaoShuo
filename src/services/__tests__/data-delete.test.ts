import { describe, it, expect, beforeEach, vi } from 'vitest'

// 删除链路回归：章节/卷/书删除必须同时清掉快照目录（此前只删正文，快照永久残留）
const { onChapterDeletedMock, onVolumeDeletedMock, deleteAllMock, syncOutlineMock } = vi.hoisted(() => ({
  onChapterDeletedMock: vi.fn(async () => {}),
  onVolumeDeletedMock: vi.fn(async () => {}),
  deleteAllMock: vi.fn(async () => {}),
  syncOutlineMock: vi.fn(async () => {}),
}))

vi.mock('../knowledge-service', () => ({
  knowledgeService: {
    onChapterDeleted: onChapterDeletedMock,
    onVolumeDeleted: onVolumeDeletedMock,
    deleteAll: deleteAllMock,
    syncOutline: syncOutlineMock,
  },
}))

import { chapterService, volumeService, novelService } from '../data-service'

const chapterRow = {
  id: 'c1',
  volume_id: 'v1',
  title: '第一章',
  order_num: 1,
  content_path: 'content/n1/c1.md',
  word_count: 100,
  target_word_count: 3000,
  status: 'draft',
  hooks: '[]',
  summary: '',
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
}

function electron() {
  return (globalThis as any).window.electronAPI as {
    file: {
      write: ReturnType<typeof vi.fn>
      exists: ReturnType<typeof vi.fn>
      delete: ReturnType<typeof vi.fn>
      deleteDir: ReturnType<typeof vi.fn>
    }
    db: { query: ReturnType<typeof vi.fn> }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        read: vi.fn(),
        write: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockResolvedValue(false),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteDir: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      db: { query: vi.fn() },
    },
  }
})

describe('章节/卷/小说删除的内容清理', () => {
  it('删除章节：正文与本章快照目录一并删除，KB 联动仍拿到 novelId', async () => {
    electron().db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT * FROM chapters')) return [chapterRow]
      if (sql.includes('SELECT novel_id FROM volumes')) return [{ novel_id: 'n1' }]
      return []
    })

    await chapterService.delete('c1')

    expect(electron().file.delete).toHaveBeenCalledWith('content/n1/c1.md')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/snapshots/n1/c1')
    expect(electron().db.query).toHaveBeenCalledWith('DELETE FROM chapters WHERE id = ?', ['c1'])
    expect(onChapterDeletedMock).toHaveBeenCalledWith('n1', 'c1')
    // 日更统计：删除的 100 字记一条负数修正，保证当日净增不会虚高
    expect(electron().file.write).toHaveBeenCalledWith(
      'content/stats/n1/sessions.jsonl',
      expect.stringContaining('"wordsAdded":-100')
    )
  })

  it('删除卷：卷下每章的快照目录都清理，且 KB 联动使用删除前取到的 novelId', async () => {
    electron().db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT novel_id FROM volumes')) return [{ novel_id: 'n1' }]
      if (sql.includes('FROM chapters WHERE volume_id')) {
        return [
          { id: 'c1', content_path: 'content/n1/c1.md' },
          { id: 'c2', content_path: 'content/n1/c2.md' },
        ]
      }
      return []
    })

    await volumeService.delete('v1')

    expect(electron().file.delete).toHaveBeenCalledWith('content/n1/c1.md')
    expect(electron().file.delete).toHaveBeenCalledWith('content/n1/c2.md')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/snapshots/n1/c1')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/snapshots/n1/c2')
    // 回归：此前在 DELETE volumes 之后才反查 novel_id，导致 KB 联动永不执行
    expect(onVolumeDeletedMock).toHaveBeenCalledWith('n1', 'v1')
  })

  it('删除小说：清掉整书快照根、章节内容目录与知识库目录', async () => {
    electron().db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM volumes')) return [{ id: 'v1' }]
      if (sql.includes('SELECT content_path FROM chapters')) {
        return [{ content_path: 'content/n1/c1.md' }]
      }
      return []
    })

    await novelService.delete('n1')

    expect(electron().file.delete).toHaveBeenCalledWith('content/n1/c1.md')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/snapshots/n1')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/n1')
    expect(deleteAllMock).toHaveBeenCalledWith('n1')
    expect(electron().file.deleteDir).toHaveBeenCalledWith('content/knowledge/n1')
  })
})
