import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 知识库服务单测（P1-2）
 *
 * 背景：knowledge-service.ts（947 行）此前零单测，而 P6 主链路从未被真实执行过一次。
 * 本文件用「内存文件系统 + mock 数据层」把 KB 主链路跑通，覆盖 v0.8 §P1-2 的 8 个 API。
 *
 * 隔离策略：
 * - window.electronAPI.file.* → 内存 Map（不落真实磁盘，避免测试间互相污染）
 * - data-service / rag-service / tracking-service / log-service → 全部 mock
 * - 被 mock 的常量放在 vi.hoisted 中，避免 vi.mock 工厂的 TDZ 问题
 */

const h = vi.hoisted(() => ({
  fs: new Map<string, string>(),
  novel: {
    id: 'n1',
    title: '测试小说',
    description: '一句话简介：少年自寒山出，一剑破万法。',
    genre: ['玄幻', '逆袭'],
    targetPlatform: '番茄',
  },
  volumes: [{ id: 'v1', novelId: 'n1', order: 1, title: '破境', summary: '卷纲：主角破境' }],
  chapters: [
    {
      id: 'c1',
      novelId: 'n1',
      volumeId: 'v1',
      order: 1,
      title: '剑出寒山',
      status: 'final',
      wordCount: 3200,
      summary: '林尘在剑冢悟出碎星剑意',
    },
    {
      id: 'c2',
      novelId: 'n1',
      volumeId: 'v1',
      order: 2,
      title: '幽冥谷',
      status: 'draft',
      wordCount: 0,
      summary: '',
    },
  ],
  characters: [
    {
      id: 'ch1',
      novelId: 'n1',
      name: '林尘',
      role: '主角',
      gender: '男',
      personality: '坚毅',
      profile: '寒山剑冢传人',
    },
  ],
  worldviews: [] as any[],
  forces: [
    {
      id: 'f1',
      novelId: 'n1',
      type: '宗门',
      name: '寒山宗',
      level: '一流',
      description: '北方第一剑宗',
      protagonistRelation: '敌对',
    },
  ],
  foreshadowings: [
    {
      id: 'fo1',
      novelId: 'n1',
      content: '玉佩来历',
      status: 'planted',
      plantedChapter: 3,
      plannedResolveChapter: 25,
    },
    {
      id: 'fo2',
      novelId: 'n1',
      content: '残魂觉醒',
      status: 'planted',
      plantedChapter: 18,
      plannedResolveChapter: 30,
    },
  ],
  indexChapterSummary: vi.fn(),
  kbLog: vi.fn(),
}))

vi.mock('../data-service', () => ({
  novelService: { getById: vi.fn(async () => h.novel) },
  volumeService: { getByNovelId: vi.fn(async () => h.volumes) },
  chapterService: {
    getById: vi.fn(async (id: string) => h.chapters.find((c) => c.id === id) ?? null),
    getByVolumeId: vi.fn(async (vid: string) => h.chapters.filter((c) => c.volumeId === vid)),
  },
  characterService: { getByNovelId: vi.fn(async () => h.characters) },
  worldviewService: { getByNovelId: vi.fn(async () => h.worldviews) },
  forceService: { getByNovelId: vi.fn(async () => h.forces) },
  foreshadowingService: { getByNovelId: vi.fn(async () => h.foreshadowings) },
}))

vi.mock('../rag-service', () => ({
  loadIndex: vi.fn(async () => undefined),
  search: vi.fn(() => []),
  indexChapterSummary: h.indexChapterSummary,
}))

vi.mock('../tracking-service', () => ({
  loadTrackingState: vi.fn(async () => ({ characterInvolvements: {} as Record<string, string[]> })),
}))

vi.mock('../log-service', () => ({
  ActionLog: { kb: h.kbLog },
}))

beforeEach(() => {
  h.fs.clear()
  h.indexChapterSummary.mockClear()
  h.kbLog.mockClear()
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        read: vi.fn(async (p: string) => {
          if (!h.fs.has(p)) throw new Error(`ENOENT: ${p}`)
          return h.fs.get(p) as string
        }),
        write: vi.fn(async (p: string, content: string) => {
          h.fs.set(p, content)
        }),
        exists: vi.fn(async (p: string) => h.fs.has(p)),
        mkdir: vi.fn(async () => undefined),
        delete: vi.fn(async (p: string) => {
          h.fs.delete(p)
        }),
        list: vi.fn(async () => [...h.fs.keys()]),
        rename: vi.fn(async (from: string, to: string) => {
          const v = h.fs.get(from)
          if (v !== undefined) {
            h.fs.set(to, v)
            h.fs.delete(from)
          }
        }),
      },
      db: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('order_num FROM volumes')) return [{ order_num: 1 }]
          if (sql.includes('FROM volumes')) return [{ id: 'v1', title: '破境', order_num: 1 }]
          return []
        }),
      },
      logAction: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    },
  }
})

import { knowledgeService } from '../knowledge-service'

const KB = 'content/knowledge/n1'
const kbPath = (rel: string) => `${KB}/${rel}`
const readKb = (rel: string) => h.fs.get(kbPath(rel))

const BRIEF = {
  summary: '林尘在寒山剑冢悟出碎星剑意，苏婉为护他挡下长老一剑。',
  keyEvents: ['林尘悟出碎星剑意', '苏婉挡剑重伤', '宗门下令通缉林尘'],
  charactersInvolved: ['林尘', '苏婉'],
  newForeshadowings: ['林尘体内残魂觉醒'],
  resolvedForeshadowings: ['苏婉的身份谜'],
  nextChapterHook: '林尘携重伤的苏婉逃入禁地幽冥谷。',
}

describe('Knowledge Service · 初始化', () => {
  it('initKnowledgeBase 生成骨架 6 件套并写入 index.json', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)

    for (const f of ['novel.md', 'outline.md', 'foreshadowings.md', 'hooks.md', 'arc.md', 'index.json']) {
      expect(h.fs.has(kbPath(f)), `缺少 ${f}`).toBe(true)
    }

    const index = JSON.parse(readKb('index.json') as string)
    expect(index.kbVersion).toBe('1.0')
    expect(index.novelId).toBe('n1')
    expect(Object.keys(index.files).sort()).toEqual([
      'arc.md',
      'foreshadowings.md',
      'hooks.md',
      'novel.md',
      'outline.md',
    ])
    // 每个条目都要有 hash / generator / updatedAt（文档三 3.3.7）
    for (const meta of Object.values(index.files) as any[]) {
      expect(meta.hash).toMatch(/^h[0-9a-f]+$/)
      expect(meta.generator).toBe('init')
      expect(typeof meta.updatedAt).toBe('string')
    }
  })

  it('novel.md 含书名 / 题材 / 进度指针 / 下一步方向', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    const md = readKb('novel.md') as string

    expect(md).toContain('title: 《测试小说》')
    expect(md).toContain('genre: 玄幻, 逆袭')
    expect(md).toContain('targetPlatform: 番茄')
    expect(md).toContain('currentVolume: 0')
    expect(md).toContain('currentChapter: 0')
    expect(md).toContain('## 一句话简介')
    expect(md).toContain('## 下一步方向')
  })

  it('initKnowledgeBaseForExistingNovel 从 SQLite 回填老书（卷纲 / 章节 / 角色 / 伏笔）', async () => {
    // 前置：知识库不存在
    expect(h.fs.has(kbPath('index.json'))).toBe(false)

    await knowledgeService.initKnowledgeBaseForExistingNovel('n1')

    expect(readKb('outline.md')).toContain('第1卷《破境》')
    expect(readKb('outline.md')).toContain('第1章《剑出寒山》')
    expect(readKb('chapters/c1.md')).toContain('林尘在剑冢悟出碎星剑意')
    expect(readKb('characters/ch1.md')).toContain('# 角色：林尘（主角）')
    expect(readKb('foreshadowings.md')).toContain('玉佩来历')
    expect(readKb('foreshadowings.md')).toContain('计划回收: 第25章')
    // 无摘要的第 2 章不应生成 KB 文件（见 knowledge-service.ts:248）
    expect(h.fs.has(kbPath('chapters/c2.md'))).toBe(false)
  })

  it('initKnowledgeBaseForExistingNovel 幂等：已有 index.json 时不重建', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.write('n1', 'novel.md', '手动改过的内容', 'manual')

    await knowledgeService.initKnowledgeBaseForExistingNovel('n1')

    expect(readKb('novel.md')).toBe('手动改过的内容')
  })
})

describe('Knowledge Service · 章节摘要落库（P6.2 主链路）', () => {
  it('applyChapterBrief 写 chapters/<id>.md，五段齐全', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    const md = readKb('chapters/c1.md') as string
    expect(md).toContain('# 第1章《剑出寒山》')
    expect(md).toContain('## 摘要')
    expect(md).toContain('悟出碎星剑意')
    expect(md).toContain('## 出场角色')
    expect(md).toContain('- 林尘')
    expect(md).toContain('## 关键事件')
    expect(md).toContain('1. 林尘悟出碎星剑意')
    expect(md).toContain('## 伏笔变更')
    expect(md).toContain('- 新增：[第1章] 林尘体内残魂觉醒')
    expect(md).toContain('- 回收：苏婉的身份谜')
    expect(md).toContain('## 下章钩子')
    expect(md).toContain('逃入禁地幽冥谷')
  })

  it('applyChapterBrief 把下章钩子追加进 hooks.md 的「未兑现」段', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    const hooks = readKb('hooks.md') as string
    expect(hooks).toContain('- [第1章] 林尘携重伤的苏婉逃入禁地幽冥谷。')
    // 必须落在「未兑现」段而非「已兑现」段
    const unresolvedIdx = hooks.indexOf('## 未兑现')
    const resolvedIdx = hooks.indexOf('## 已兑现')
    const lineIdx = hooks.indexOf('- [第1章]')
    expect(unresolvedIdx).toBeGreaterThanOrEqual(0)
    expect(lineIdx).toBeGreaterThan(unresolvedIdx)
    expect(lineIdx).toBeLessThan(resolvedIdx)
  })

  it('applyChapterBrief 推进 novel.md 进度指针与「下一步方向」', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    expect(readKb('novel.md')).toContain('currentChapter: 0')

    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    const md = readKb('novel.md') as string
    expect(md).toContain('currentChapter: 1')
    expect(md).toContain('林尘携重伤的苏婉逃入禁地幽冥谷。')
  })

  it('applyChapterBrief 联动 RAG 重新索引本章摘要', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    expect(h.indexChapterSummary).toHaveBeenCalledTimes(1)
    expect(h.indexChapterSummary).toHaveBeenCalledWith('n1', 'c1', '剑出寒山', BRIEF.summary, 1)
  })

  it('applyChapterBrief 对不存在的章节安全返回（不抛错、不写文件）', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await expect(knowledgeService.applyChapterBrief('n1', 'not-exist', BRIEF)).resolves.toBeUndefined()
    expect(h.fs.has(kbPath('chapters/not-exist.md'))).toBe(false)
  })
})

describe('Knowledge Service · 全书概要与爽点曲线（P6.3 / P6.5）', () => {
  it('applyNovelSummary 写 novel.md 与各 volumes/<id>.md', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyNovelSummary('n1', {
      novel_summary: '少年自寒山出，一剑破万法。',
      volume_summaries: [
        {
          volumeId: 'v1',
          title: '破境',
          theme: '从废柴到破境的逆袭',
          mainPlot: '林尘入剑冢 → 悟剑意 → 被通缉',
          endingHook: '幽冥谷中传来远古血脉的呼唤',
        },
      ],
      current_position: { volume: 1, chapter: 2, title: '幽冥谷' },
      next_direction: '写第 3 章：幽冥谷遇险',
    })

    const novelMd = readKb('novel.md') as string
    expect(novelMd).toContain('少年自寒山出，一剑破万法。')
    expect(novelMd).toContain('currentVolume: 1')
    expect(novelMd).toContain('currentChapter: 2')
    expect(novelMd).toContain('写第 3 章：幽冥谷遇险')

    const volMd = readKb('volumes/v1.md') as string
    expect(volMd).toContain('# 第1卷《破境》')
    expect(volMd).toContain('## 卷主题')
    expect(volMd).toContain('从废柴到破境的逆袭')
    expect(volMd).toContain('## 卷主线')
    expect(volMd).toContain('## 卷尾钩子')
    expect(volMd).toContain('幽冥谷中传来远古血脉的呼唤')
  })

  it('applyArcDesign 写 arc.md', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyArcDesign('n1', '卷1·章1  情绪：屈辱-压抑  爽点：0')

    const arc = readKb('arc.md') as string
    expect(arc).toContain('# 情绪/爽点曲线')
    expect(arc).toContain('情绪：屈辱-压抑')
    const index = JSON.parse(readKb('index.json') as string)
    expect(index.files['arc.md'].generator).toBe('story-arc-design')
  })
})

describe('Knowledge Service · 导航层装配（P6.4）', () => {
  it('assembleNavigationContext 按序输出总览 / 当前卷 / 当前章节 / 伏笔 / 钩子', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    const ctx = await knowledgeService.assembleNavigationContext('n1', 'c1')

    expect(ctx).toContain('═══ 知识库·小说总览 ═══')
    expect(ctx).toContain('═══ 知识库·当前卷 ═══')
    expect(ctx).toContain('═══ 知识库·当前章节简要 ═══')
    expect(ctx).toContain('═══ 知识库·伏笔账本 ═══')
    expect(ctx).toContain('═══ 知识库·钩子地图 ═══')

    // 顺序断言：总览必须最先（注入 system prompt 开头）
    expect(ctx.indexOf('小说总览')).toBeLessThan(ctx.indexOf('伏笔账本'))
    expect(ctx.indexOf('伏笔账本')).toBeLessThan(ctx.indexOf('钩子地图'))
    // 内容断言：导航层真的带了进度与钩子
    expect(ctx).toContain('currentChapter: 1')
    expect(ctx).toContain('逃入禁地幽冥谷')
  })

  it('assembleNavigationContext 在 KB 不存在时仍返回内容（自动初始化，不抛错）', async () => {
    const ctx = await knowledgeService.assembleNavigationContext('n1')
    expect(typeof ctx).toBe('string')
    expect(ctx).toContain('知识库·小说总览')
  })
})

describe('Knowledge Service · 读写一致性与删除联动', () => {
  it('write → read → delete 与 index 条目同步', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.write('n1', 'volumes/v1.md', '# 第1卷《破境》', 'manual-test')

    expect(await knowledgeService.read('n1', 'volumes/v1.md')).toBe('# 第1卷《破境》')
    let index = JSON.parse(readKb('index.json') as string)
    expect(index.files['volumes/v1.md'].generator).toBe('manual-test')

    await knowledgeService.delete('n1', 'volumes/v1.md')
    expect(await knowledgeService.read('n1', 'volumes/v1.md')).toBeNull()
    index = JSON.parse(readKb('index.json') as string)
    expect(index.files['volumes/v1.md']).toBeUndefined()
  })

  it('deleteAll 清空知识库（删小说级联）', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)

    await knowledgeService.deleteAll('n1')

    for (const f of ['novel.md', 'outline.md', 'index.json', 'chapters/c1.md']) {
      expect(h.fs.has(kbPath(f)), `${f} 应被删除`).toBe(false)
    }
  })

  it('onChapterDeleted 删除章节文件并刷新大纲', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)
    expect(h.fs.has(kbPath('chapters/c1.md'))).toBe(true)

    await knowledgeService.onChapterDeleted('n1', 'c1')

    expect(h.fs.has(kbPath('chapters/c1.md'))).toBe(false)
    // syncOutline 仍会重写 outline.md
    expect(readKb('outline.md')).toContain('第1卷《破境》')
  })

  it('onVolumeDeleted 删除卷文件及其下所有章节文件', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    await knowledgeService.applyChapterBrief('n1', 'c1', BRIEF)
    await knowledgeService.write('n1', 'volumes/v1.md', '# 第1卷《破境》', 'manual')

    await knowledgeService.onVolumeDeleted('n1', 'v1')

    expect(h.fs.has(kbPath('volumes/v1.md'))).toBe(false)
    expect(h.fs.has(kbPath('chapters/c1.md'))).toBe(false)
  })

  it('listFiles 返回按路径排序的文件元数据', async () => {
    await knowledgeService.initKnowledgeBase('n1', h.novel as any)
    const files = await knowledgeService.listFiles('n1')

    expect(files.length).toBeGreaterThanOrEqual(5)
    const paths = files.map((f) => f.path)
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
    const novelEntry = files.find((f) => f.path === 'novel.md')
    expect(novelEntry?.size).toBeGreaterThan(0)
    expect(novelEntry?.generator).toBe('init')
  })
})
