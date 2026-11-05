import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// F3：题材模板落库单测。mock 掉三个下游服务，只验证 template-service 的编排逻辑。

vi.mock('../outline-planner', () => ({
  applyProspectiveOutline: vi.fn(async () => ({ volumes: 3, chapters: 3, characters: 3 })),
}))

vi.mock('../data-service', () => ({
  novelService: {
    getById: vi.fn(async () => ({ id: 'n1', title: '我的书', description: '   ', genre: [] })),
  },
  worldviewService: {
    getByNovelId: vi.fn(async () => [{ title: '重生时间线' }]),
    create: vi.fn(async () => ({ id: 'wv_new' })),
  },
}))

vi.mock('../knowledge-service', () => ({
  knowledgeService: {
    write: vi.fn(async () => {}),
  },
}))

import { applyNovelTemplate, saveUserTemplate, listUserTemplates } from '../template-service'
import { applyProspectiveOutline } from '../outline-planner'
import { novelService, worldviewService } from '../data-service'
import { knowledgeService } from '../knowledge-service'
import { NOVEL_TEMPLATES } from '@/config/novel-templates'

const TEMPLATE = NOVEL_TEMPLATES[0]

describe('NOVEL_TEMPLATES 结构自检', () => {
  it('模板 id 唯一且字段完整', () => {
    const ids = NOVEL_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of NOVEL_TEMPLATES) {
      expect(t.name).toBeTruthy()
      expect(t.genres.length).toBeGreaterThan(0)
      expect(t.blurb).toBeTruthy()
      expect(t.descriptionExample).toBeTruthy()
      expect(t.characters.length).toBeGreaterThanOrEqual(2)
      expect(t.worldviewEntries.length).toBeGreaterThanOrEqual(1)
      expect(t.masterPlan.masterOutline).toBeTruthy()
      expect(t.masterPlan.volumes.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('每套模板的 goldenThree 恰为 3 章且每章有钩子', () => {
    for (const t of NOVEL_TEMPLATES) {
      expect(t.goldenThree).toHaveLength(3)
      for (const ch of t.goldenThree) {
        expect(ch.title).toBeTruthy()
        expect(ch.hooks.length).toBeGreaterThanOrEqual(2)
        for (const h of ch.hooks) expect(h.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('applyNovelTemplate（模板落库编排）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('简介为空时补填模板示例，且不改书名', async () => {
    await applyNovelTemplate('n1', TEMPLATE)
    expect(applyProspectiveOutline).toHaveBeenCalledTimes(1)
    const input = (applyProspectiveOutline as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(input.confirmed.title).toBe('')
    expect(input.confirmed.premise).toBe(TEMPLATE.descriptionExample)
    expect(input.confirmed.genre).toBe(TEMPLATE.genres[0])
    expect(input.confirmed.characters).toEqual(TEMPLATE.characters)
    expect(input.masterPlan).toBe(TEMPLATE.masterPlan)
    expect(input.firstVolumeChapters).toEqual(TEMPLATE.goldenThree)
  })

  it('简介非空时不覆盖用户文字（premise 传空）', async () => {
    ;(novelService.getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'n1', title: '我的书', description: '用户自己写的简介', genre: [],
    })
    await applyNovelTemplate('n1', TEMPLATE)
    const input = (applyProspectiveOutline as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(input.confirmed.premise).toBe('')
  })

  it('世界观条目：重名跳过、其余创建', async () => {
    // TEMPLATE 世界观条目含「重生时间线」，与已有条目重名 → 只创建其余
    const result = await applyNovelTemplate('n1', TEMPLATE)
    expect(worldviewService.create).toHaveBeenCalledTimes(TEMPLATE.worldviewEntries.length - 1)
    expect(result.worldviewEntries).toBe(TEMPLATE.worldviewEntries.length - 1)
    expect(result.chapters).toBe(3)
  })

  it('KB 写入 template-notes.md，内容含模板名与建议', async () => {
    await applyNovelTemplate('n1', TEMPLATE)
    expect(knowledgeService.write).toHaveBeenCalledTimes(1)
    const [novelId, path, content, generator] = (knowledgeService.write as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(novelId).toBe('n1')
    expect(path).toBe('template-notes.md')
    expect(content).toContain(`模板笔记：${TEMPLATE.name}`)
    expect(content).toContain('建议下一步')
    expect(generator).toBe('template-service')
  })
})

// F4：用户模板（拆书产物）存取 round-trip（mock electronAPI.file）
describe('用户模板存取（saveUserTemplate / listUserTemplates）', () => {
  const store = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    store.clear()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      file: {
        write: vi.fn(async (path: string, content: string) => { store.set(path, content) }),
        read: vi.fn(async (path: string) => {
          if (!store.has(path)) throw new Error('not found')
          return store.get(path)!
        }),
        list: vi.fn(async (dir: string) =>
          [...store.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.split('/').pop()!),
        ),
      },
    }
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('round-trip：保存后能列出并完整读回', async () => {
    await saveUserTemplate(TEMPLATE)
    const list = await listUserTemplates()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(TEMPLATE)
  })

  it('损坏 JSON 与缺字段文件跳过，不影响其他模板', async () => {
    await saveUserTemplate(TEMPLATE)
    await saveUserTemplate({ ...TEMPLATE, id: 'tpl-bad', name: '坏模板' })
    // 写入一个损坏 JSON 与一个缺 goldenThree 的文件
    store.set('content/templates/broken.json', '{not json')
    store.set('content/templates/incomplete.json', JSON.stringify({ id: 'x', name: '缺骨架' }))

    const list = await listUserTemplates()
    expect(list.map((t) => t.id).sort()).toEqual(['tpl-bad', TEMPLATE.id].sort())
  })

  it('无 electronAPI 时：saveUserTemplate 抛错，listUserTemplates 返回空', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    await expect(saveUserTemplate(TEMPLATE)).rejects.toThrow()
    await expect(listUserTemplates()).resolves.toEqual([])
  })
})
