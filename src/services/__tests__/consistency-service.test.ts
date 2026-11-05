import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scanForeshadowParity, scanKbSqliteConsistency } from '../consistency-service'

// ===== mock 状态（vi.mock 工厂仅在回调期读取，避免 TDZ）=====
const mockStore = {
  volumes: [] as any[],
  chapters: [] as any[],
  characters: [] as any[],
  foreshadowings: [] as any[],
  files: {} as Record<string, string>, // 相对 content/ 的路径 -> 内容
}

vi.mock('../data-service', () => ({
  volumeService: {
    getByNovelId: vi.fn(async () => mockStore.volumes),
  },
  chapterService: {
    getByVolumeId: vi.fn(async (vid: string) => mockStore.chapters.filter((c) => c.volumeId === vid)),
  },
  characterService: {
    getByNovelId: vi.fn(async () => mockStore.characters),
  },
  foreshadowingService: {
    getByNovelId: vi.fn(async () => mockStore.foreshadowings),
  },
}))

describe('scanForeshadowParity（P2-3：check-foreshadow-parity 语义移植）', () => {
  it('无标记文本：对账通过，计数为 0', () => {
    const r = scanForeshadowParity([{ key: '本章', content: '正常正文，没有伏笔标记。' }])
    expect(r.ok).toBe(true)
    expect(r.plantedCount).toBe(0)
    expect(r.resolvedCount).toBe(0)
  })

  it('跨单元先埋后收：通过，无悬空无错配', () => {
    const r = scanForeshadowParity([
      { key: '第1章', content: '他在书里夹了一张字条 [F-1 埋设]。' },
      { key: '第3章', content: '字条的真相终于揭开 [F-1 回收]。' },
    ])
    expect(r.ok).toBe(true)
    expect(r.plantedCount).toBe(1)
    expect(r.resolvedCount).toBe(1)
    expect(r.dangling).toHaveLength(0)
    expect(r.earlyResolves).toHaveLength(0)
  })

  it('单章门禁：回收无埋设（错配）→ 拦截，报告含定位', () => {
    const r = scanForeshadowParity([
      { key: '本章', content: '他终于明白当年字条的含义 [F-7 回收]，却没人记得字条从何而来。' },
    ])
    expect(r.ok).toBe(false)
    expect(r.orphanResolves).toEqual([{ id: '7', where: '本章' }])
    expect(r.report).toContain('回收无埋设')
    expect(r.report).toContain('[F-7]')
  })

  it('同章即收（可疑）→ 拦截', () => {
    const r = scanForeshadowParity([
      { key: '本章', content: '他发现字条 [F-2 埋设]，下一页就写明了答案 [F-2 回收]。' },
    ])
    expect(r.ok).toBe(false)
    expect(r.earlyResolves).toEqual([{ id: '2', where: '本章' }])
    expect(r.report).toContain('同章即收')
  })

  it('埋设未回收：跨章中间态仅报告，不拦截（ok 仍为 true）', () => {
    const r = scanForeshadowParity([
      { key: '第1章', content: '[F-9 埋设] 神秘的钥匙出现了。' },
      { key: '第2章', content: '别的剧情。' },
    ])
    expect(r.ok).toBe(true)
    expect(r.dangling).toEqual([{ id: '9', where: '第1章' }])
    expect(r.report).toContain('未回收（中间态）')
    expect(r.report).toContain('[F-9]')
  })

  it('标记格式兼容冒号变体（与脚本正则一致）', () => {
    const r = scanForeshadowParity([
      { key: '第1章', content: '[F-abc-12: 埋设] 出现。' },
      { key: '第2章', content: '[F-abc-12：回收] 收束。' },
    ])
    expect(r.plantedCount).toBe(1)
    expect(r.resolvedCount).toBe(1)
    expect(r.ok).toBe(true)
  })
})

describe('scanKbSqliteConsistency（P2-6：KB/SQLite 一致性扫描）', () => {
  const NOVEL = 'novel-1'
  const VOL1 = 'vol-1'
  const CH1 = 'ch-1'
  const kb = (rel: string) => `content/knowledge/${NOVEL}/${rel}`

  function seedElectron(files: Record<string, string | null>) {
    ;(window as any).electronAPI = {
      file: {
        read: vi.fn(async (p: string) => files[p] ?? null),
        exists: vi.fn(async (p: string) => files[p] != null),
      },
    }
  }

  beforeEach(() => {
    mockStore.volumes = [{ id: VOL1, novelId: NOVEL, title: '第一卷', order: 1 }]
    mockStore.chapters = [
      { id: CH1, volumeId: VOL1, title: '第一章', order: 1, summary: '有摘要的章' },
      { id: 'ch-2', volumeId: VOL1, title: '第二章', order: 2, summary: '' },
    ]
    mockStore.characters = [{ id: 'c1' }]
    mockStore.foreshadowings = []
  })

  it('健康状态：index 文件齐全、有摘要章节的 md 存在 → ok', async () => {
    seedElectron({
      [kb('index.json')]: JSON.stringify({
        files: { 'novel.md': {}, [`chapters/${CH1}.md`]: {} },
      }),
      [kb('novel.md')]: '# 小说',
      [kb(`chapters/${CH1}.md`)]: '---\nchapterId: ch-1\n---',
    })
    const r = await scanKbSqliteConsistency(NOVEL)
    expect(r.ok).toBe(true)
    expect(r.counts.indexEntries).toBe(2)
    expect(r.counts.chaptersInDb).toBe(2) // 含无摘要章
    expect(r.counts.chapterMdOnDisk).toBe(1)
    expect(r.counts.charactersInDb).toBe(1)
    expect(r.report).toContain('一致性正常')
  })

  it('验收场景：手动删除 chapters/*.md → 告警不通过', async () => {
    seedElectron({
      [kb('index.json')]: JSON.stringify({ files: { [`chapters/${CH1}.md`]: {} } }),
      // chapters/ch-1.md 已被手动删除
    })
    const r = await scanKbSqliteConsistency(NOVEL)
    expect(r.ok).toBe(false)
    expect(r.missingChapterMd).toEqual([{ chapterId: CH1, title: '第一章' }])
    expect(r.report).toContain('章节 md 缺失')
    expect(r.report).toContain('《第一章》')
  })

  it('index.json 声明的文件磁盘缺失 → missingKbFiles', async () => {
    seedElectron({
      [kb('index.json')]: JSON.stringify({ files: { 'outline.md': {}, 'hooks.md': {} } }),
      [kb('outline.md')]: '# 大纲',
      // hooks.md 缺失
    })
    const r = await scanKbSqliteConsistency(NOVEL)
    expect(r.ok).toBe(false)
    expect(r.missingKbFiles).toEqual(['hooks.md'])
    expect(r.report).toContain('KB 文件缺失')
  })

  it('index.json 不存在（未初始化）：不视为不一致', async () => {
    mockStore.volumes = []
    mockStore.chapters = []
    mockStore.characters = []
    seedElectron({})
    const r = await scanKbSqliteConsistency(NOVEL)
    expect(r.ok).toBe(true)
    expect(r.counts.indexEntries).toBe(0)
    expect(r.counts.chaptersInDb).toBe(0)
  })
})
