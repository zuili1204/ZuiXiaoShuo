import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock window.electronAPI：file 与 db 双通道
// 快照服务的依赖链：chapterService.getById（db.query chapters）→ resolveNovelId（db.query volumes）
// → loadContent（file.read contentPath）→ file.list/write/delete 快照目录
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

beforeEach(() => {
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        read: vi.fn(),
        write: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      db: {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM chapters')) return [chapterRow]
          if (sql.includes('FROM volumes')) return [{ novel_id: 'n1' }]
          return []
        }),
      },
    },
  }
})

import {
  createSnapshot,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  parseSnapshotName,
} from '../snapshot-service'

const api = () => (globalThis as any).window.electronAPI

// 与 snapshot-service 同格式的本地时间戳（测试辅助）
const pad = (n: number) => String(n).padStart(2, '0')
function fmt(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

describe('parseSnapshotName', () => {
  it('解析合法快照文件名为元数据', () => {
    const meta = parseSnapshotName('20261007-120000-auto.md')
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('auto')
    expect(meta!.ts).toBe(new Date('2026-10-07T12:00:00').getTime())
  })

  it('拒绝非法文件名（脏文件/路径拼接）', () => {
    expect(parseSnapshotName('../evil.md')).toBeNull()
    expect(parseSnapshotName('not-a-snapshot.md')).toBeNull()
    expect(parseSnapshotName('20261007-120000-hacker.md')).toBeNull()
    expect(parseSnapshotName('20261007-120000-manual-x.md')).toBeNull()
  })

  it('识别同秒冲突序号后缀（-1/-2 不再被当成脏文件）', () => {
    const meta = parseSnapshotName('20261007-120000-manual-1.md')
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('manual')
    expect(meta!.seq).toBe(1)
    expect(meta!.ts).toBe(new Date('2026-10-07T12:00:00').getTime())
    expect(parseSnapshotName('20261007-120000-auto.md')!.seq).toBe(0)
  })
})

describe('createSnapshot', () => {
  it('空章节不写快照', async () => {
    api().file.read.mockResolvedValue('')
    const created = await createSnapshot('c1', 'manual', { force: true })
    expect(created).toBe(false)
    expect(api().file.write).not.toHaveBeenCalled()
  })

  it('正常写入快照文件（路径含 snapshots/novelId/chapterId）', async () => {
    api().file.read.mockResolvedValue('当前正文内容')
    const created = await createSnapshot('c1', 'manual', { force: true })
    expect(created).toBe(true)
    expect(api().file.write).toHaveBeenCalledTimes(1)
    const [path, content] = api().file.write.mock.calls[0]
    expect(path).toBe(`content/snapshots/n1/c1/${path.split('/').pop()}`)
    expect(path).toMatch(/^content\/snapshots\/n1\/c1\/\d{8}-\d{6}-manual\.md$/)
    expect(content).toBe('当前正文内容')
  })

  it('auto 来源限流：10 分钟内已有 auto 快照则跳过', async () => {
    const now = new Date('2026-10-07T12:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const recent = new Date(now.getTime() - 5 * 60 * 1000)
      api().file.list.mockResolvedValue([`${fmt(recent)}-auto.md`])
      api().file.read.mockResolvedValue('当前正文内容')

      const created = await createSnapshot('c1', 'auto')
      expect(created).toBe(false)
      expect(api().file.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto 限流可被 force 覆盖', async () => {
    const now = new Date('2026-10-07T12:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const recent = new Date(now.getTime() - 60 * 1000)
      api().file.list.mockResolvedValue([`${fmt(recent)}-auto.md`])
      api().file.read.mockResolvedValue('当前正文内容')

      const created = await createSnapshot('c1', 'auto', { force: true })
      expect(created).toBe(true)
      expect(api().file.write).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto 距上次快照超过 10 分钟则放行', async () => {
    const now = new Date('2026-10-07T12:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const elevenMinAgo = new Date(now.getTime() - 11 * 60 * 1000)
      api().file.list.mockResolvedValue([`${fmt(elevenMinAgo)}-auto.md`])
      api().file.read.mockResolvedValue('当前正文内容')

      const created = await createSnapshot('c1', 'auto')
      expect(created).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('保留策略：超出 50 份删除最老快照', async () => {
    const base = new Date('2026-10-07T12:00:00').getTime()
    // 预置 50 份（按时间升序），本次再写 1 份 → 溢出 1 份，删最老的
    const names: string[] = []
    for (let i = 0; i < 50; i++) {
      names.push(`${fmt(new Date(base - (60 - i) * 60 * 1000))}-manual.md`)
    }
    // list 动态返回：预置名单 + 本次已写入的快照（模拟真实目录）
    const written: string[] = []
    api().file.list.mockImplementation(async () => [...names, ...written])
    api().file.write.mockImplementation(async (path: string) => {
      written.push(path.split('/').pop() ?? '')
    })
    api().file.read.mockResolvedValue('当前正文内容')

    await createSnapshot('c1', 'manual', { force: true })

    expect(api().file.delete).toHaveBeenCalledTimes(1)
    const deletedPath = api().file.delete.mock.calls[0][0] as string
    expect(deletedPath).toContain(names[0]) // 最老的一份被删
  })

  it('同一秒内重复快照时文件名追加序号避免覆盖', async () => {
    const now = new Date('2026-10-07T12:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      api().file.list.mockResolvedValue([`${fmt(now)}-manual.md`])
      api().file.read.mockResolvedValue('当前正文内容')

      await createSnapshot('c1', 'manual', { force: true })

      const writtenPath = api().file.write.mock.calls[0][0] as string
      expect(writtenPath).toMatch(/-manual-1\.md$/)
      // 回归：带序号的文件必须可解析，否则会被列表/保留策略永久忽略
      expect(parseSnapshotName(writtenPath.split('/').pop()!)).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('listSnapshots', () => {
  it('按时间倒序返回（新的在前），脏文件被过滤', async () => {
    api().file.list.mockResolvedValue([
      '20261007-120000-auto.md',
      '20261007-110000-manual.md',
      'garbage.txt',
    ])
    const metas = await listSnapshots('c1')
    expect(metas).toHaveLength(2)
    expect(metas[0].name).toBe('20261007-120000-auto.md')
    expect(metas[1].name).toBe('20261007-110000-manual.md')
    expect(metas[0].source).toBe('auto')
    expect(metas[1].source).toBe('manual')
  })

  it('目录不存在（list 抛错）时返回空数组', async () => {
    api().file.list.mockRejectedValue(new Error('ENOENT'))
    const metas = await listSnapshots('c1')
    expect(metas).toEqual([])
  })

  it('同秒序号快照被列出，并按序号排序（新的在前）', async () => {
    api().file.list.mockResolvedValue([
      '20261007-120000-manual.md',
      '20261007-120000-manual-1.md',
    ])
    const metas = await listSnapshots('c1')
    expect(metas.map((m) => m.name)).toEqual([
      '20261007-120000-manual-1.md',
      '20261007-120000-manual.md',
    ])
  })
})

describe('readSnapshot', () => {
  it('拒绝非法快照名，不触达文件系统', async () => {
    await expect(readSnapshot('c1', '../../secrets.md')).rejects.toThrow('非法')
    expect(api().file.read).not.toHaveBeenCalled()
  })

  it('合法快照名读取对应路径', async () => {
    api().file.read.mockResolvedValue('快照内容')
    const content = await readSnapshot('c1', '20261007-120000-auto.md')
    expect(content).toBe('快照内容')
    expect(api().file.read).toHaveBeenCalledWith('content/snapshots/n1/c1/20261007-120000-auto.md')
  })
})

describe('restoreSnapshot', () => {
  it('恢复前强制留存 pre-restore 快照，再写回正文', async () => {
    api().file.read.mockImplementation(async (path: string) => {
      // 快照路径读出「快照内容」，正文路径读出「当前正文」
      if (path.includes('snapshots/')) return '快照内容'
      return '当前正文'
    })

    const restored = await restoreSnapshot('c1', '20261007-120000-auto.md')

    expect(restored).toBe('快照内容')
    const writes = api().file.write.mock.calls as [string, string][]
    // 第一次写 = pre-restore 快照（保存恢复前的当前正文）
    expect(writes[0][0]).toMatch(/-pre-restore\.md$/)
    expect(writes[0][1]).toBe('当前正文')
    // 第二次写 = saveContent 写回正文咽喉（contentPath）
    expect(writes[1][0]).toBe('content/n1/c1.md')
    expect(writes[1][1]).toBe('快照内容')
  })
})
