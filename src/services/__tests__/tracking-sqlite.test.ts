import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Checkpoint, QualityGate } from '@shared/types'
import {
  saveCheckpoint, loadCheckpoints, loadResumePoint, saveLedgerEntry, loadLedger,
  commitChapterAndSave,
} from '../tracking-service'

// ===== 内存版 db.query，模拟 SQLite 行为（仅实现 tracking-service 用到的语句）=====
const tables: {
  director_checkpoints: any[]
  role_ledger: any[]
  chapters: any[]
  volumes: any[]
  foreshadowings: any[]
} = {
  director_checkpoints: [],
  role_ledger: [],
  chapters: [],
  volumes: [],
  foreshadowings: [],
}

function mockQuery(sql: string, params: any[] = []): any[] {
  if (sql.includes('INSERT INTO director_checkpoints')) {
    const [id, task_id, novel_id, stage_index, agent_role, intent, input, output, quality_json, status, created_at] = params
    const idx = tables.director_checkpoints.findIndex((r) => r.id === id)
    const row = { id, task_id, novel_id, stage_index, agent_role, intent, input, output, quality_json, status, created_at }
    if (idx >= 0) tables.director_checkpoints[idx] = row
    else tables.director_checkpoints.push(row)
    return []
  }
  if (sql.includes('INSERT INTO role_ledger')) {
    const [id, novel_id, chapter_title, chain_json, updated_at] = params
    const idx = tables.role_ledger.findIndex((r) => r.id === id)
    const row = { id, novel_id, chapter_title, chain_json, updated_at }
    if (idx >= 0) tables.role_ledger[idx] = row
    else tables.role_ledger.push(row)
    return []
  }
  if (sql.includes('FROM director_checkpoints') && sql.includes('status IN')) {
    const novelId = params[0]
    return tables.director_checkpoints.filter(
      (r) => r.novel_id === novelId && ['pending', 'awaiting-approval'].includes(r.status)
    )
  }
  if (sql.includes('FROM director_checkpoints')) {
    const novelId = params[0]
    return tables.director_checkpoints.filter((r) => r.novel_id === novelId)
  }
  if (sql.includes('FROM role_ledger')) {
    const novelId = params[0]
    return tables.role_ledger.filter((r) => r.novel_id === novelId)
  }
  // ---- 伏笔表 ----
  if (sql.includes('INSERT INTO foreshadowings')) {
    const [id, novel_id, content, planted_chapter, planned_resolve_chapter, resolved_chapter, status, importance, created_at] = params
    tables.foreshadowings.push({ id, novel_id, content, planted_chapter, planned_resolve_chapter, resolved_chapter, status, importance, created_at })
    return []
  }
  if (sql.includes('UPDATE foreshadowings SET status')) {
    const [status, resolved_chapter, id] = params
    const row = tables.foreshadowings.find((r) => r.id === id)
    if (row) {
      row.status = status
      row.resolved_chapter = resolved_chapter
    }
    return []
  }
  if (sql.includes('FROM foreshadowings')) {
    // 同时覆盖 SELECT content / SELECT * 两种（均按 novel_id 过滤）
    const novelId = params[0]
    return tables.foreshadowings.filter((r) => r.novel_id === novelId)
  }
  // ---- 章节表（注意 volume_id 分支须先于 id 分支判断）----
  if (sql.includes('UPDATE chapters SET')) {
    const [summary, word_count, updated_at, id] = params
    const row = tables.chapters.find((r) => r.id === id)
    if (row) {
      row.summary = summary
      row.word_count = word_count
      row.updated_at = updated_at
      if (sql.includes("status = 'final'")) row.status = 'final'
    }
    return []
  }
  if (sql.includes('FROM chapters') && sql.includes('volume_id')) {
    const volumeId = params[0]
    return tables.chapters
      .filter((r) => r.volume_id === volumeId)
      .sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0))
  }
  if (sql.includes('FROM chapters')) {
    const id = params[0]
    const row = tables.chapters.find((r) => r.id === id)
    return row ? [row] : []
  }
  // ---- 卷表 ----
  if (sql.includes('FROM volumes')) {
    const novelId = params[0]
    return tables.volumes
      .filter((r) => r.novel_id === novelId)
      .sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0))
  }
  return []
}

beforeEach(() => {
  tables.director_checkpoints.length = 0
  tables.role_ledger.length = 0
  tables.chapters.length = 0
  tables.volumes.length = 0
  tables.foreshadowings.length = 0
  ;(globalThis as any).window = {
    electronAPI: {
      db: { query: mockQuery },
      file: { exists: async () => false, read: async () => '', write: async () => {} },
    },
  }
})

const NOVEL = 'nov-sqlite'

describe('P6 检查点 SQLite 落库', () => {
  it('saveCheckpoint 落库后 loadCheckpoints 可回读，且 quality JSON 正确反序列化', async () => {
    const quality: QualityGate = {
      score: 90, passed: true, deslopTag: true, aiPatternHits: 0, degenerationHits: 0, report: 'ok', checkedAt: 't',
    }
    const cp: Checkpoint = {
      id: 'task-1-setup', taskId: 'task-1', novelId: NOVEL, stageIndex: 0, agentRole: 'architect',
      intent: '灵感', input: '立项', output: '设定文本', quality, status: 'completed', createdAt: '2026-01-01',
    }
    await saveCheckpoint(NOVEL, cp)
    const loaded = await loadCheckpoints(NOVEL)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('task-1-setup')
    expect(loaded[0].quality).toEqual(quality)
    expect(loaded[0].agentRole).toBe('architect')
  })

  it('同一 id 再次 saveCheckpoint 覆盖而非重复', async () => {
    const cp: Checkpoint = {
      id: 'task-1-setup', taskId: 'task-1', novelId: NOVEL, stageIndex: 0, agentRole: 'architect',
      output: 'v1', status: 'completed', createdAt: '2026-01-01',
    }
    await saveCheckpoint(NOVEL, cp)
    const cp2: Checkpoint = { ...cp, output: 'v2', status: 'awaiting-approval' }
    await saveCheckpoint(NOVEL, cp2)
    const loaded = await loadCheckpoints(NOVEL)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].output).toBe('v2')
    expect(loaded[0].status).toBe('awaiting-approval')
  })

  it('loadResumePoint 仅返回 pending / awaiting-approval 的检查点', async () => {
    const done: Checkpoint = { id: 'a', taskId: 't', novelId: NOVEL, stageIndex: 0, agentRole: 'architect', output: 'x', status: 'completed', createdAt: 't' }
    const pend: Checkpoint = { id: 'b', taskId: 't', novelId: NOVEL, stageIndex: 1, agentRole: 'writer', output: 'y', status: 'awaiting-approval', createdAt: 't' }
    await saveCheckpoint(NOVEL, done)
    await saveCheckpoint(NOVEL, pend)
    const resume = await loadResumePoint(NOVEL)
    expect(resume).toHaveLength(1)
    expect(resume[0].id).toBe('b')
  })
})

describe('P6 角色资源账本 SQLite 落库', () => {
  it('saveLedgerEntry 落库后 loadLedger 可回读，chain JSON 正确反序列化', async () => {
    const entry = {
      id: 'ledger-1', novelId: NOVEL, chapterTitle: '第一章',
      chain: [
        { agentRole: 'writer' as const, action: 'generate' as const, status: 'done' as const, output: '第一章' },
        { agentRole: 'checker' as const, action: 'review' as const, status: 'done' as const },
        { agentRole: 'runtime' as const, action: 'inject' as const, status: 'done' as const },
      ],
      updatedAt: '2026-01-01',
    }
    await saveLedgerEntry(entry)
    const loaded = await loadLedger(NOVEL)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].chapterTitle).toBe('第一章')
    expect(loaded[0].chain).toHaveLength(3)
    expect(loaded[0].chain[0].action).toBe('generate')
  })

  it('同一 id 再次 saveLedgerEntry 覆盖而非重复', async () => {
    const e1 = { id: 'l', novelId: NOVEL, chapterTitle: 'A', chain: [], updatedAt: 't' }
    const e2 = { id: 'l', novelId: NOVEL, chapterTitle: 'B', chain: [], updatedAt: 't2' }
    await saveLedgerEntry(e1)
    await saveLedgerEntry(e2)
    const loaded = await loadLedger(NOVEL)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].chapterTitle).toBe('B')
  })

  it('不同 novelId 的账本相互隔离', async () => {
    await saveLedgerEntry({ id: 'x1', novelId: NOVEL, chapterTitle: 'A', chain: [], updatedAt: 't' })
    await saveLedgerEntry({ id: 'y1', novelId: 'other', chapterTitle: 'B', chain: [], updatedAt: 't' })
    const loaded = await loadLedger(NOVEL)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].chapterTitle).toBe('A')
  })
})

describe('D-T5-2 伏笔 commit 幂等（SQLite 路径）', () => {
  function seedNovel() {
    tables.volumes.push({
      id: 'vol-1', novel_id: NOVEL, title: '第一卷', order_num: 1,
      summary: null, created_at: '2026-01-01',
    })
    tables.chapters.push({
      id: 'ch-1', volume_id: 'vol-1', title: '第一章', order_num: 1,
      summary: null, word_count: 0, status: 'draft', content_path: 'content/ch-1.md',
      created_at: '2026-01-01', updated_at: '2026-01-01',
    })
  }

  const baseInput = {
    chapterId: 'ch-1',
    chapterTitle: '第一章',
    summary: '主角觉醒金手指',
    wordCount: 1200,
    keyEvents: ['觉醒'],
    charactersInvolved: ['主角'],
    // IMP-03：commit 必须携带正文（或磁盘已有正文），否则拒绝把章节标记为 final
    content: '这是本章正文（测试用）。'.repeat(20),
  }

  it('首次 commit：批内重复内容去重，章节落盘为 final', async () => {
    seedNovel()
    const result = await commitChapterAndSave(NOVEL, {
      ...baseInput,
      newForeshadowings: ['伏笔A', '伏笔A', '伏笔B'],
      resolvedForeshadowings: [],
      plotQuestions: [],
    })
    const contents = tables.foreshadowings.map((r) => r.content)
    expect(contents).toEqual(['伏笔A', '伏笔B'])
    expect(tables.foreshadowings.every((r) => r.novel_id === NOVEL && r.status === 'planted')).toBe(true)
    expect(tables.chapters[0].status).toBe('final')
    expect(tables.chapters[0].word_count).toBe(1200)
    expect(tables.chapters[0].summary).toBe('主角觉醒金手指')
    expect(result.committedChapters).toHaveLength(1)
  })

  it('重复 commit 同章：不产生重复伏笔行，新伏笔正常追加，回收标记生效', async () => {
    seedNovel()
    await commitChapterAndSave(NOVEL, {
      ...baseInput,
      newForeshadowings: ['伏笔A', '伏笔A', '伏笔B'],
      resolvedForeshadowings: [],
      plotQuestions: [],
    })
    // 模拟用户再次点击「完成本章」：重叠旧伏笔 + 一条新伏笔 + 回收 B
    const result = await commitChapterAndSave(NOVEL, {
      ...baseInput,
      newForeshadowings: ['伏笔A', '伏笔C'],
      resolvedForeshadowings: ['伏笔B'],
      plotQuestions: [],
    })
    const contents = tables.foreshadowings.map((r) => r.content)
    expect(contents).toEqual(['伏笔A', '伏笔B', '伏笔C'])
    const fsB = tables.foreshadowings.find((r) => r.content === '伏笔B')
    expect(fsB.status).toBe('resolved')
    expect(result.committedChapters).toHaveLength(1)
  })

  it('IMP-03：正文为空时拒绝提交，章节不会被标记为 final（防 DB 显示完成但 md 为空）', async () => {
    seedNovel()
    await expect(
      commitChapterAndSave(NOVEL, {
        ...baseInput,
        content: undefined,
        newForeshadowings: ['伏笔X'],
        resolvedForeshadowings: [],
        plotQuestions: [],
      })
    ).rejects.toThrow(/正文为空/)

    // 关键回归点：既不能把空章节标成 final，也不应产生副作用伏笔
    expect(tables.chapters[0].status).toBe('draft')
    expect(tables.foreshadowings).toHaveLength(0)
  })
})
