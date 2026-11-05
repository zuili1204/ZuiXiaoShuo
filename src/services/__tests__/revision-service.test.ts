import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../story-check-service', () => ({
  checkChapterContinuity: vi.fn(),
}))

import { checkChapterContinuity } from '../story-check-service'
import {
  addRevisionTask,
  analyzeImpact,
  applyDiff,
  collectKnownEntities,
  computeDiff,
  deleteRevisionTask,
  extractChangedEntities,
  listNovelChapters,
  loadRevisionTasks,
  runCascadeCheck,
  updateRevisionTaskStatus,
} from '../revision-service'

const volumeRows = [
  { id: 'v1', novel_id: 'n1', title: '第一卷', order_num: 1, summary: '', created_at: '', updated_at: '' },
]
const chapterRows = [
  {
    id: 'c1', volume_id: 'v1', title: '第一章', order_num: 1, content_path: 'content/n1/c1.md',
    word_count: 10, target_word_count: 3000, status: 'draft', hooks: '[]',
    summary: '', created_at: '', updated_at: '',
  },
  {
    id: 'c2', volume_id: 'v1', title: '第二章', order_num: 2, content_path: 'content/n1/c2.md',
    word_count: 10, target_word_count: 3000, status: 'draft', hooks: '[]',
    summary: '', created_at: '', updated_at: '',
  },
  {
    id: 'c3', volume_id: 'v1', title: '第三章', order_num: 3, content_path: 'content/n1/c3.md',
    word_count: 10, target_word_count: 3000, status: 'draft', hooks: '[]',
    summary: '', created_at: '', updated_at: '',
  },
]

const files = new Map<string, string>()

beforeEach(() => {
  files.clear()
  vi.clearAllMocks()
  files.set('content/n1/c1.md', '林晚推开门。')
  files.set('content/n1/c2.md', '苏晚推开门，看见林晚站在门外。')
  files.set('content/n1/c3.md', '雨停了。')
  ;(globalThis as any).window = {
    electronAPI: {
      db: {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM volumes')) return volumeRows
          if (sql.includes('FROM chapters WHERE id = ?')) {
            return chapterRows.filter((r) => r.id === params[0])
          }
          if (sql.includes('FROM chapters WHERE volume_id')) {
            return chapterRows.filter((r) => r.volume_id === params[0])
          }
          if (sql.includes('FROM characters')) {
            return [{ id: 'ch1', novel_id: 'n1', name: '林晚', role: 'protagonist', profile: '', dynamic_state: '' }]
          }
          return []
        }),
      },
      file: {
        read: vi.fn(async (path: string) => {
          const value = files.get(path)
          if (value == null) throw new Error('ENOENT')
          return value
        }),
        write: vi.fn(async (path: string, content: string) => {
          files.set(path, content)
        }),
      },
    },
  }
})

describe('P1.5 段/行级 diff', () => {
  it('相同文本全部为未改动段', () => {
    const diff = computeDiff('甲\n乙', '甲\n乙')
    expect(diff.summary).toEqual({ added: 0, removed: 0, unchanged: 2 })
    expect(diff.segments.every((s) => s.kind === 'equal')).toBe(true)
  })

  it('全部采用等于新稿，全部撤回等于旧稿', () => {
    const oldText = '第一行\n第二行\n第三行'
    const newText = '第一行\n第二行改\n第三行\n第四行'
    const diff = computeDiff(oldText, newText)

    expect(diff.summary.added).toBe(2)
    expect(diff.summary.removed).toBe(1)
    expect(applyDiff(diff.segments, {})).toBe(newText)

    const rejectAll: Record<string, boolean> = {}
    diff.segments.filter((s) => s.kind !== 'equal').forEach((s) => { rejectAll[s.key] = false })
    expect(applyDiff(diff.segments, rejectAll)).toBe(oldText)
  })

  it('可逐段采用：只保留新增行但撤回替换段', () => {
    const diff = computeDiff('甲\n乙\n戊', '甲\n丙\n戊\n丁')
    const accepted: Record<string, boolean> = {}
    diff.segments.forEach((s) => {
      accepted[s.key] = s.kind === 'added' && s.lines.includes('丁')
    })
    expect(applyDiff(diff.segments, accepted)).toBe('甲\n乙\n戊\n丁')
  })

  it('从改动段中提取已知实体', () => {
    const diff = computeDiff('林晚推门。', '苏晚推门。')
    const entities = extractChangedEntities(diff.segments, [
      { name: '林晚', kind: 'character' },
      { name: '苏晚', kind: 'character' },
    ])
    expect(entities.map((e) => e.name).sort()).toEqual(['林晚', '苏晚'])
  })
})

describe('P1.5 影响分析', () => {
  it('全书章节按卷序章序拉平', async () => {
    const refs = await listNovelChapters('n1')
    expect(refs.map((r) => r.chapter.id)).toEqual(['c1', 'c2', 'c3'])
    expect(refs.map((r) => r.order)).toEqual([1, 2, 3])
  })

  it('只检索源章之后的章节并给出命中句子', async () => {
    const report = await analyzeImpact({
      novelId: 'n1',
      sourceChapterId: 'c1',
      entities: [{ name: '林晚', kind: 'character' }],
    })
    expect(report.scannedChapters).toBe(2)
    expect(report.hits).toHaveLength(1)
    expect(report.hits[0]).toMatchObject({
      chapterId: 'c2',
      chapterTitle: '第二章',
      entity: '林晚',
    })
    expect(report.hits[0].sentence).toContain('林晚')
  })

  it('实体名不足两字时不参与检索（避免噪音）', async () => {
    const report = await analyzeImpact({
      novelId: 'n1',
      sourceChapterId: 'c1',
      entities: [{ name: '林', kind: 'keyword' }],
    })
    expect(report.entities).toHaveLength(0)
    expect(report.hits).toHaveLength(0)
    expect(report.scannedChapters).toBe(0)
  })

  it('优先从角色名收集已知实体', async () => {
    const entities = await collectKnownEntities('n1')
    expect(entities[0]).toEqual({ name: '林晚', kind: 'character' })
  })
})

describe('P1.5 级联检查', () => {
  it('受影响章跑出 finding，不修改正文', async () => {
    vi.mocked(checkChapterContinuity).mockResolvedValue([
      { ruleId: 'dead-character', severity: 'blocking', message: '角色已死亡仍出场' },
    ])
    const report = await runCascadeCheck({ novelId: 'n1', chapterIds: ['c2'] })

    expect(report.scannedChapters).toBe(1)
    expect(report.blocking).toBe(1)
    expect(report.chapters[0].chapterTitle).toBe('第二章')
    expect(report.chapters[0].findings[0].message).toContain('死亡')
    expect(files.get('content/n1/c2.md')).toBe('苏晚推开门，看见林晚站在门外。')
  })

  it('空章节不参与级联检查', async () => {
    files.set('content/n1/c2.md', '')
    const report = await runCascadeCheck({ novelId: 'n1', chapterIds: ['c2'] })
    expect(report.scannedChapters).toBe(1)
    expect(report.chapters).toHaveLength(0)
  })
})

describe('P1.5 修订任务', () => {
  it('创建、读回、状态流转与删除均落 tasks.json', async () => {
    const task = await addRevisionTask({
      novelId: 'n1',
      sourceChapterId: 'c1',
      targetChapterId: 'c2',
      type: 'continuity',
      description: '确认改名后第二章是否仍一致',
    })

    expect(task.status).toBe('open')
    expect(files.has('content/revisions/n1/tasks.json')).toBe(true)

    const loaded = await loadRevisionTasks('n1')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].description).toContain('改名')

    const done = await updateRevisionTaskStatus('n1', task.id, 'done')
    expect(done[0].status).toBe('done')
    expect(done[0].resolvedAt).toBeTruthy()

    const afterDelete = await deleteRevisionTask('n1', task.id)
    expect(afterDelete).toHaveLength(0)
  })

  it('任务文件损坏时返回空列表而不是抛错', async () => {
    files.set('content/revisions/n1/tasks.json', '{broken')
    await expect(loadRevisionTasks('n1')).resolves.toEqual([])
  })
})
