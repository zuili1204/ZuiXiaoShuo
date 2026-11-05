import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseSeedProposal,
  parseMasterPlan,
  parseChapterSkeletons,
  parseChapterDetailPayload,
  parseOutlineReviewPayload,
  parseRecalibrateDiff,
  splitWrittenUnwritten,
  buildProspectiveOutlineMd,
  buildSeedSeedSection,
  buildSeedAssistTask,
  buildSeedHumanizeTask,
  applyHumanizedItems,
  humanizeKeepsFacts,
  factTokens,
  isHumanizeField,
  parseSeedAssistPayload,
  applyCalibration,
  applyChapterDetail,
  applyProspectiveOutline,
  applyReviewPatches,
  applySeedProposal,
  applyVolumeChapters,
  seedWorldviewEntries,
} from '../outline-planner'

// ===== mock 状态（vi.mock 工厂仅在回调期读取，避免 TDZ）=====
const mockStore = {
  novel: null as any,
  novelUpdates: [] as any[],
  volumes: [] as any[],
  volumeCreates: [] as any[],
  chapters: [] as any[],
  chapterUpdates: [] as { id: string; patch: any }[],
  content: {} as Record<string, string>,
  characters: [] as any[],
  characterCreates: [] as any[],
  worldviews: [] as any[],
  worldviewCreates: [] as any[],
  kbWrites: [] as { file: string; content: string; origin: string }[],
  syncs: [] as string[],
}

vi.mock('../data-service', () => ({
  novelService: {
    getById: vi.fn(async () => mockStore.novel),
    update: vi.fn(async (_id: string, patch: any) => {
      mockStore.novelUpdates.push(patch)
    }),
  },
  volumeService: {
    getByNovelId: vi.fn(async () => mockStore.volumes),
    create: vi.fn(async (v: any) => {
      mockStore.volumeCreates.push(v)
    }),
  },
  chapterService: {
    getById: vi.fn(async (id: string) => mockStore.chapters.find((c) => c.id === id) ?? null),
    getByVolumeId: vi.fn(async (volumeId: string) => mockStore.chapters.filter((c) => c.volumeId === volumeId)),
    create: vi.fn(async (c: any) => {
      mockStore.chapters.push(c)
    }),
    update: vi.fn(async (id: string, patch: any) => {
      mockStore.chapterUpdates.push({ id, patch })
    }),
    loadContent: vi.fn(async (id: string) => mockStore.content[id] ?? ''),
  },
  characterService: {
    getByNovelId: vi.fn(async () => mockStore.characters),
    create: vi.fn(async (c: any) => {
      mockStore.characterCreates.push(c)
    }),
  },
  worldviewService: {
    getByNovelId: vi.fn(async () => mockStore.worldviews),
    create: vi.fn(async (w: any) => {
      mockStore.worldviewCreates.push(w)
    }),
  },
}))

vi.mock('../knowledge-service', () => ({
  knowledgeService: {
    write: vi.fn(async (_n: string, file: string, content: string, origin: string) => {
      mockStore.kbWrites.push({ file, content, origin })
    }),
    syncCharacters: vi.fn(async () => {
      mockStore.syncs.push('characters')
    }),
    syncOutline: vi.fn(async () => {
      mockStore.syncs.push('outline')
    }),
  },
}))

beforeEach(() => {
  mockStore.novel = null
  mockStore.novelUpdates = []
  mockStore.volumes = []
  mockStore.volumeCreates = []
  mockStore.chapters = []
  mockStore.chapterUpdates = []
  mockStore.content = {}
  mockStore.characters = []
  mockStore.characterCreates = []
  mockStore.worldviews = []
  mockStore.worldviewCreates = []
  mockStore.kbWrites = []
  mockStore.syncs = []
})

// ===== 解析器 =====

describe('outline-planner · parseSeedProposal', () => {
  it('正常提案：解析书名/类型/梗概/角色', () => {
    const out = JSON.stringify({
      titles: ['书甲', '书乙', '书丙'],
      genre: '都市日常',
      premise: '旧书摊与社团的合作',
      characters: [
        { name: '江砚', role: 'protagonist', profile: '高三，喜欢修旧钟表' },
        { name: '苏禾', role: 'supporting', profile: '高二，嘴硬心软' },
        { name: '路人甲', role: 'unknown-role', profile: '角色非法 role 兜底为 supporting' },
      ],
    })
    const p = parseSeedProposal(out)!
    expect(p.titles).toHaveLength(3)
    expect(p.genre).toBe('都市日常')
    expect(p.characters).toHaveLength(3)
    expect(p.characters[2].role).toBe('supporting')
  })

  it('含 Markdown 代码块包裹 / 前后废话：仍能提取 JSON', () => {
    const out = '好的，以下是提案：\n```json\n{"titles":["书"],"genre":"悬疑","premise":"案发","characters":[]}\n```\n请查收'
    expect(parseSeedProposal(out)!.titles).toEqual(['书'])
  })

  it('非 JSON / 空提案：返回 null', () => {
    expect(parseSeedProposal('我写不出来')).toBeNull()
    expect(parseSeedProposal('{"genre":"悬疑"}')).toBeNull() // titles 与 premise 双空
  })
})

describe('outline-planner · parseMasterPlan', () => {
  it('主线 + 分卷正常解析；title 空白的卷被过滤', () => {
    const out = JSON.stringify({
      masterOutline: '# 主线\n核心冲突……',
      volumes: [
        { title: '开局', summary: '卷纲一' },
        { title: '  ', summary: '应被过滤' },
        { title: '转折', summary: '' },
      ],
    })
    const p = parseMasterPlan(out)!
    expect(p.masterOutline).toContain('核心冲突')
    expect(p.volumes).toHaveLength(2)
    expect(p.volumes[1]).toEqual({ title: '转折', summary: '' })
  })

  it('主线与分卷双空：返回 null', () => {
    expect(parseMasterPlan('{"masterOutline":"  ","volumes":[]}')).toBeNull()
  })
})

describe('outline-planner · parseChapterSkeletons', () => {
  it('章骨架解析：hooks 过滤空白项', () => {
    const out = JSON.stringify({
      chapters: [
        { title: '还不如直接泡你', hooks: ['表白事件爆发', ' ', '下章钩子'] },
        { title: '', hooks: ['应被过滤'] },
      ],
    })
    const p = parseChapterSkeletons(out)!
    expect(p).toHaveLength(1)
    expect(p[0].hooks).toEqual(['表白事件爆发', '下章钩子'])
  })

  it('空 chapters：返回 null', () => {
    expect(parseChapterSkeletons('{"chapters":[]}')).toBeNull()
  })
})

// ===== 重订走向：解析与红线 =====

const unwrittenMap = new Map([
  ['ch-u1', { volumeId: 'vol-1', volumeOrder: 1, chapterOrder: 31, chapterTitle: '第三十一章', oldHooks: ['旧钩子1'] }],
  ['ch-u2', { volumeId: 'vol-1', volumeOrder: 1, chapterOrder: 32, chapterTitle: '第三十二章', oldHooks: [] }],
])

describe('outline-planner · parseRecalibrateDiff', () => {
  it('保留未写章条目；指向已写章/未知章的条目被红线丢弃并计数', () => {
    const out = JSON.stringify({
      summary: '第30章结尾已变，后续需承接',
      items: [
        { chapterId: 'ch-u1', newHooks: ['新走向A', '新走向B'], reason: '承接新结尾' },
        { chapterId: 'ch-written', newHooks: ['妄图改已写章'], reason: '必须被拦' },
        { chapterId: 'ch-unknown', newHooks: ['不存在的章'], reason: '必须被拦' },
        { chapterId: 'ch-u2', newHooks: [], reason: '空 hooks 必须被拦' },
      ],
    })
    const d = parseRecalibrateDiff(out, unwrittenMap)!
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({
      chapterId: 'ch-u1',
      volumeOrder: 1,
      chapterOrder: 31,
      oldHooks: ['旧钩子1'],
      newHooks: ['新走向A', '新走向B'],
      reason: '承接新结尾',
    })
    expect(d.skipped).toBe(3)
  })

  it('全被拦截时 items 为空但结果合法（UI 提示无需调整）', () => {
    const out = JSON.stringify({ summary: '无需调整', items: [{ chapterId: 'ch-written', newHooks: ['x'] }] })
    const d = parseRecalibrateDiff(out, unwrittenMap)!
    expect(d.items).toHaveLength(0)
    expect(d.skipped).toBe(1)
  })
})

// ===== 读写状态二分 =====

describe('outline-planner · splitWrittenUnwritten', () => {
  it('wordCount>0 或磁盘有正文 → 已写；二者皆无 → 未写', () => {
    const { written, unwritten } = splitWrittenUnwritten(
      [
        { id: 'a', wordCount: 3000, volumeId: 'v1', order: 1, title: '甲', hooks: [] },
        { id: 'b', wordCount: 0, volumeId: 'v1', order: 2, title: '乙', hooks: [] },
        { id: 'c', wordCount: 0, volumeId: 'v1', order: 3, title: '丙', hooks: ['钩'] },
      ],
      { b: '磁盘上有正文但未回写字数' },
    )
    expect(written.map((c) => c.id)).toEqual(['a', 'b'])
    expect(unwritten.map((c) => c.id)).toEqual(['c'])
    expect(unwritten[0].hooks).toEqual(['钩'])
  })
})

// ===== 逐块 AI 规划解析 =====

describe('outline-planner · parseSeedAssistPayload', () => {
  it('合法建议：保留顺序、去重、去掉空白', () => {
    const p = parseSeedAssistPayload({
      field: 'title',
      suggestions: ['夜班便利店', '  ', '夜班便利店', '雾港来信'],
      reason: '贴合悬疑类型',
      warnings: ['书名偏冷门'],
    })!
    expect(p.field).toBe('title')
    expect(p.suggestions).toEqual(['夜班便利店', '雾港来信'])
    expect(p.reason).toBe('贴合悬疑类型')
    expect(p.warnings).toEqual(['书名偏冷门'])
  })

  it('非法字段或空建议直接丢弃', () => {
    expect(parseSeedAssistPayload({ field: 'nope', suggestions: ['a'] })).toBeNull()
    expect(parseSeedAssistPayload({ field: 'title', suggestions: [' '] })).toBeNull()
    expect(parseSeedAssistPayload(null)).toBeNull()
  })

  it('建议数量上限 5 条', () => {
    const p = parseSeedAssistPayload({
      field: 'genre',
      suggestions: ['a', 'b', 'c', 'd', 'e', 'f'],
    })!
    expect(p.suggestions).toHaveLength(5)
  })

  it('解析结构化 items，并与 suggestions 一一对齐', () => {
    const p = parseSeedAssistPayload({
      field: 'premise',
      suggestions: ['两元一次的拥抱摊，每周日在校门口开张。', '他能修好任何旧钟表，却唯独修不好同桌的那只。'],
      items: [
        {
          text: '两元一次的拥抱摊，每周日在校门口开张。',
          axis: '日常仪式',
          scene: '校门口的小摊，班主任排在第三个',
          functionPositions: ['可重复仪式'],
          whyItWorks: '固定时间地点，读者每周都能等一次',
          risks: [],
        },
        {
          text: '他能修好任何旧钟表，却唯独修不好同桌的那只。',
          axis: '关系流',
          scene: '早读时同桌头顶一片空白',
          functionPositions: ['可见进度条', '合法亲密借口'],
          whyItWorks: '例外制造追读理由',
        },
      ],
    })!
    expect(p.items).toHaveLength(2)
    expect(p.items![0].axis).toBe('日常仪式')
    expect(p.items![0].scene).toContain('班主任')
    expect(p.items![1].functionPositions).toContain('合法亲密借口')
    expect(p.suggestions).toEqual(p.items!.map((item) => item.text))
  })

  it('items 与 suggestions 重复时按文本去重', () => {
    const p = parseSeedAssistPayload({
      field: 'title',
      suggestions: ['夜班便利店', '夜班便利店', '雾港来信'],
      items: [{ text: '夜班便利店', axis: '轻喜剧' }],
    })!
    expect(p.suggestions).toEqual(['夜班便利店', '雾港来信'])
    expect(p.items).toHaveLength(2)
  })
})

describe('outline-planner · buildSeedAssistTask', () => {
  const seed = {
    genre: '都市异能',
    protagonist: '林见 —— 高三学生',
    draft: '两个社团伙伴，关系与事件绑定',
  }

  it('携带全部线索、目标块要求与作者方向', () => {
    const task = buildSeedAssistTask('worldview', seed, '轻松搞笑，不要苦大仇深')
    expect(task).toContain('世界观与设定')
    expect(task).toContain('草稿区')
    expect(task).toContain('林见')
    expect(task).toContain('两个社团伙伴')
    expect(task).toContain('轻松搞笑，不要苦大仇深')
    expect(task).toContain('"field":"worldview"')
    expect(task).toContain('名场面')
    expect(task).toContain('关系推进')
  })

  it('没有方向时不出现作者方向段；方向超长按 3000 字截断', () => {
    expect(buildSeedAssistTask('title', seed)).not.toContain('作者方向（优先遵守')
    const task = buildSeedAssistTask('title', seed, 'x'.repeat(3500))
    expect(task).toContain('x'.repeat(3000))
    expect(task).not.toContain('x'.repeat(3001))
  })

  it('世界观/能力要求不鼓励堆枷锁与代价', () => {
    const task = buildSeedAssistTask('power', seed)
    expect(task).toContain('服务喜剧和关系推进')
    expect(task).toContain('不要越用越惨')
  })

  it('梗概候选要求开场就能拍，而不是从背景讲到现状的简介', () => {
    const task = buildSeedAssistTask('premise', seed)
    expect(task).toContain('开场就能拍')
    expect(task).toContain('40~120 字')
    expect(task).toContain('至少一条压到 50 字以内')
    expect(task).toContain('第一句直接写人物正在做的事')
    expect(task).toContain('不要用「四个X、一本Y、一个Z」式清单收尾')
    expect(task).toContain('三条的落点要错开')
    expect(task).toContain('至少有一个明确的答应、拒绝、隐瞒或交换')
    expect(task).toContain('结尾优先停在人物的即时反应')
    expect(task).toContain('不要用「他记得是 X，本子上写着 Y」这种客观对照收尾')
    expect(task).toContain('能断句就不要用破折号')
    expect(task).toContain('不对呀，这道题他做过')
    expect(task).not.toContain('像网文简介')
    expect(buildSeedAssistTask('title', seed)).toContain('不新增、不改名、不合并')
    expect(buildSeedAssistTask('title', seed)).toContain('「回声定位」不要写成「雷达」')
  })

  it('whyItWorks 只写事实，不写评价；reason/warnings 不点评已填内容', () => {
    const task = buildSeedAssistTask('premise', seed)
    expect(task).toContain('≤20 字')
    expect(task).toContain('不写「好看/笑点/读者会期待/现成」这类评价')
    expect(task).toContain('warnings 只写真正的设定冲突或需要作者拍板的选择')
  })

  it('要求结构化 items、多轴候选与可重复场面', () => {
    const task = buildSeedAssistTask('premise', seed)
    expect(task).toContain('"items"')
    expect(task).toContain('"axis"')
    expect(task).toContain('"scene"')
    expect(task).toContain('沿不同轴发散')
    expect(task).toContain('可重复')
    expect(task).toContain('连载')
    expect(task).toContain('角色选择')
  })

  it('传入叙事工程卡时注入作者锚点且声明禁止复用专有名词', () => {
    const task = buildSeedAssistTask('premise', seed, undefined, {
      sourceNames: ['旧作'],
      strength: 60,
      craftCard: '【叙事工程】\n- 节奏与钩子：章末停在画面上',
      anchors: ['［chapter_end］她袖口的手表带印，一直没退。'],
    })
    expect(task).toContain('作者作品的叙事指纹')
    expect(task).toContain('她袖口的手表带印')
    expect(task).toContain('禁止复用其中的人名/地名/专有名词与情节')
  })

  it('没有文风库时仍注入现代连载基线', () => {
    const task = buildSeedAssistTask('premise', seed)
    expect(task).toContain('五个功能位')
    expect(task).toContain('章末停在画面/动作/台词/信息/未完成动作/误会之一')
  })

  it('人物块改为场面优先，禁止「功能/缺口/口头禅」档案体', () => {
    const characters = buildSeedAssistTask('characters', seed)
    expect(characters).toContain('不要写成设定档案')
    expect(characters).toContain('禁止「功能 / 缺口 / 关系标签 / 口头禅」')
    expect(characters).not.toContain('格式：名字（主角/反派/配角）')
    const protagonist = buildSeedAssistTask('protagonist', seed)
    expect(protagonist).toContain('能直接拍出来的片段')
    expect(protagonist).not.toContain('格式：姓名 —— 身份')
    expect(protagonist).toContain('分析只放进 whyItWorks/risks')
  })
})

// ===== 输入组装 / 大纲文档 =====

describe('outline-planner · buildSeedSeedSection / buildProspectiveOutlineMd', () => {
  it('种子线索：缺失维度以「（未提供）」占位，已有维度原样保留', () => {
    const s = buildSeedSeedSection({ title: '书名', premise: '梗概' })
    expect(s).toContain('- 书名：书名')
    expect(s).toContain('- 一句话梗概：梗概')
    expect(s).toContain('- 类型：（未提供）')
    expect(s).toContain('- 主角：（未提供）')
    expect(s).toContain('- 其他角色：（未提供）')
    expect(s).toContain('- 世界观与设定：（未提供）')
    expect(s).toContain('- 基调与读者：（未提供）')
    expect(s).toContain('- 期望卷数：（未提供）')
  })

  it('世界观与基调随线索进入生成输入', () => {
    const s = buildSeedSeedSection({
      worldview: '雾港常年大雾，记忆可被典当',
      tone: '冷峻悬疑，面向成年读者',
    })
    expect(s).toContain('- 世界观与设定：雾港常年大雾，记忆可被典当')
    expect(s).toContain('- 基调与读者：冷峻悬疑，面向成年读者')
  })

  it('新增线索块与草稿区全部进入生成输入', () => {
    const s = buildSeedSeedSection({
      coreConflict: '主角想查真相，但每查一步身边的人更危险',
      protagonist: '江砚 —— 高三转学生',
      setting: '近未来沿海城市',
      power: '能看见三分钟后的死亡',
      sellingPoints: '倒计时压迫感',
      references: '《长夜难明》',
      taboos: '不要恋爱主线',
      draft: '想写一场雨夜追车',
    })
    expect(s).toContain('- 核心冲突：主角想查真相，但每查一步身边的人更危险')
    expect(s).toContain('- 主角：江砚 —— 高三转学生')
    expect(s).toContain('- 时代与地点：近未来沿海城市')
    expect(s).toContain('- 金手指/核心能力：能看见三分钟后的死亡')
    expect(s).toContain('- 卖点与爽点：倒计时压迫感')
    expect(s).toContain('- 对标作品：《长夜难明》')
    expect(s).toContain('- 禁忌与雷点：不要恋爱主线')
    expect(s).toContain('- 草稿区（作者随手记录，需整理后采纳）：想写一场雨夜追车')
  })

  it('前瞻大纲 markdown：含书名/主线/分卷/首卷章骨架', () => {
    const md = buildProspectiveOutlineMd(
      { title: '书', genre: '悬疑', premise: 'p', characters: [], volumeCount: 2 },
      { masterOutline: '主线全文', volumes: [{ title: '第一卷', summary: '卷纲一' }, { title: '第二卷', summary: '卷纲二' }] },
      [{ title: '第一章', hooks: ['骨架一', '骨架二'] }],
    )
    expect(md).toContain('# 全书大纲（《书》· 悬疑）')
    expect(md).toContain('## 主线')
    expect(md).toContain('主线全文')
    expect(md).toContain('### 第1卷《第一卷》')
    expect(md).toContain('- 第1章《第一章》：骨架一；骨架二')
    expect(md).toContain('### 第2卷《第二卷》')
    // 非首卷不出章骨架
    expect(md.indexOf('- 第1章', md.indexOf('第2卷'))).toBe(-1)
  })
})

// ===== applyCalibration：落库红线 =====

describe('outline-planner · applyCalibration', () => {
  it('未写章正常回写 hooks；已写章（字数>0 或磁盘有正文）绝不回写', async () => {
    mockStore.chapters = [
      { id: 'u', volumeId: 'v1', order: 3, title: '未写', wordCount: 0, hooks: [] },
      { id: 'w1', volumeId: 'v1', order: 1, title: '已写', wordCount: 5000, hooks: [] },
      { id: 'w2', volumeId: 'v1', order: 2, title: '磁盘有稿', wordCount: 0, hooks: [] },
    ]
    mockStore.content['w2'] = '磁盘正文'
    const n = await applyCalibration([
      { chapterId: 'u', volumeId: 'v1', volumeOrder: 1, chapterOrder: 3, chapterTitle: '未写', oldHooks: [], newHooks: ['新钩'], reason: '' },
      { chapterId: 'w1', volumeId: 'v1', volumeOrder: 1, chapterOrder: 1, chapterTitle: '已写', oldHooks: [], newHooks: ['妄图改'], reason: '' },
      { chapterId: 'w2', volumeId: 'v1', volumeOrder: 1, chapterOrder: 2, chapterTitle: '磁盘有稿', oldHooks: [], newHooks: ['妄图改'], reason: '' },
      { chapterId: 'ghost', volumeId: 'v1', volumeOrder: 1, chapterOrder: 9, chapterTitle: '不存在', oldHooks: [], newHooks: ['x'], reason: '' },
    ])
    expect(n).toBe(1)
    expect(mockStore.chapterUpdates).toEqual([{ id: 'u', patch: { hooks: ['新钩'] } }])
  })
})

// ===== applyProspectiveOutline：落库路径 =====

describe('outline-planner · applyProspectiveOutline', () => {
  it('更新立项信息、追加卷、首卷建章带 hooks、角色重名跳过、写 prose 版 outline.md', async () => {
    mockStore.novel = { id: 'n1', title: '旧书名', description: '', genre: ['悬疑'] }
    mockStore.volumes = [{ id: 'v0', novelId: 'n1', title: '已有卷', order: 2, summary: '' }]
    mockStore.characters = [{ id: 'c0', name: '江砚', role: 'protagonist', profile: '已有' }]

    const r = await applyProspectiveOutline('n1', {
      confirmed: {
        title: '新书名', genre: '悬疑', premise: '新梗概',
        characters: [
          { name: '江砚', role: 'protagonist', profile: '重名应跳过' },
          { name: '苏禾', role: 'supporting', profile: '新建' },
        ],
        volumeCount: 2,
      },
      masterPlan: { masterOutline: '主线', volumes: [{ title: '卷A', summary: '纲A' }, { title: '卷B', summary: '纲B' }] },
      firstVolumeChapters: [{ title: '第一章', hooks: ['骨架'] }],
    })

    expect(r).toEqual({ volumes: 2, chapters: 1, characters: 1 })
    // 立项信息：书名/梗概变化才写；genre 未变化不重复写入
    expect(mockStore.novelUpdates).toEqual([{ title: '新书名', description: '新梗概' }])
    // 新卷 order 接在已有卷之后
    expect(mockStore.volumeCreates.map((v) => ({ title: v.title, order: v.order }))).toEqual([
      { title: '卷A', order: 3 },
      { title: '卷B', order: 4 },
    ])
    // 首个新卷建章
    expect(mockStore.chapters).toHaveLength(1)
    expect(mockStore.chapters[0]).toMatchObject({ volumeId: mockStore.volumeCreates[0].id, title: '第一章', order: 1, hooks: ['骨架'], wordCount: 0, status: 'draft' })
    // outline.md 为 prose 版（含主线），且不调用 syncOutline
    expect(mockStore.kbWrites).toHaveLength(1)
    expect(mockStore.kbWrites[0]).toMatchObject({ file: 'outline.md', origin: 'outline-planner' })
    expect(mockStore.kbWrites[0].content).toContain('主线')
  })

  it('章骨架携带 targetWordCount 时按契约值落库，越界回退 3000', async () => {
    await applyProspectiveOutline('n1', {
      confirmed: { title: '书', genre: '', premise: 'p', characters: [], volumeCount: 1 },
      masterPlan: { masterOutline: '主线', volumes: [{ title: '卷A', summary: '纲A' }] },
      firstVolumeChapters: [
        { title: '第一章', hooks: ['甲'], targetWordCount: 4500 },
        { title: '第二章', hooks: ['乙'], targetWordCount: 99 },
      ],
    })
    expect(mockStore.chapters.map((c) => c.targetWordCount)).toEqual([4500, 3000])
  })
})

// ===== P1 契约 payload 解析 =====

describe('outline-planner · A1-A6 契约载荷兼容', () => {
  it('A1：中文角色 + desire/obstacle/flaw 映射为向导 profile，保留扩展字段', () => {
    const text = JSON.stringify({
      stage: 'seed',
      baseRevision: 'r1',
      payload: {
        titles: ['书甲'],
        genre: '都市悬疑',
        premise: '法医收到自己的死亡证明',
        synopsis: '旧案重启。',
        coreConflict: '查真相 vs 被阻止',
        characters: [
          { name: '林岸', role: '主角', desire: '查清旧案', obstacle: '被停职', flaw: '固执' },
          { name: '周砚', role: '反派', desire: '掩盖', obstacle: '林岸逼近' },
        ],
        worldAnchors: ['雾港多雾'],
        sellingPoints: ['倒计时'],
        tone: '冷峻',
        audience: '悬疑读者',
      },
      warnings: ['【假设】默认单主角'],
    })
    const p = parseSeedProposal(text)!
    expect(p.characters[0]).toEqual({ name: '林岸', role: 'protagonist', profile: '查清旧案；被停职；固执' })
    expect(p.characters[1].role).toBe('antagonist')
    expect(p.synopsis).toBe('旧案重启。')
    expect(p.coreConflict).toBe('查真相 vs 被阻止')
    expect(p.worldAnchors).toEqual(['雾港多雾'])
    expect(p.tone).toBe('冷峻')
  })

  it('A2：保留 goal / climax / endingHook / estimatedChapters / targetWordCount', () => {
    const p = parseMasterPlan(JSON.stringify({
      masterOutline: '主线',
      volumes: [
        { title: '卷A', summary: '纲A', goal: '目标', climax: '高潮', endingHook: '钩', estimatedChapters: 12, targetWordCount: 36000 },
      ],
      targetChapters: 12,
    }))!
    expect(p.targetChapters).toBe(12)
    expect(p.volumes[0]).toMatchObject({ title: '卷A', goal: '目标', climax: '高潮', endingHook: '钩', estimatedChapters: 12, targetWordCount: 36000 })
  })

  it('A3：保留 conflict / turn / payoff / targetWordCount', () => {
    const p = parseChapterSkeletons(JSON.stringify({
      chapters: [{ title: '雨夜来客', hooks: ['发生什么'], conflict: '冲突', turn: '转折', payoff: '落点', targetWordCount: 3200 }],
    }))!
    expect(p[0]).toMatchObject({ title: '雨夜来客', conflict: '冲突', turn: '转折', payoff: '落点', targetWordCount: 3200 })
  })

  it('A6：接受 diffs 契约与信封包裹，仍执行未写章红线', () => {
    const text = JSON.stringify({
      stage: 'calibrate',
      baseRevision: 'r1',
      payload: {
        summary: '承接新结尾',
        diffs: [
          { chapterId: 'ch-u1', oldHooks: ['旧钩子1'], newHooks: ['新走向'], reason: '承接', rippleEffects: ['影响第32章'] },
          { chapterId: 'ch-written', oldHooks: [], newHooks: ['妄图改'], reason: '应拦截' },
        ],
      },
      warnings: [],
    })
    const d = parseRecalibrateDiff(text, unwrittenMap)!
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({ chapterId: 'ch-u1', newHooks: ['新走向'], rippleEffects: ['影响第32章'] })
    expect(d.skipped).toBe(1)
  })
})

// ===== P1.5 A4 章细纲 / A5 体检 =====

describe('outline-planner · A4 章细纲', () => {
  it('解析 summary / hooks / 目标字数 / continuityNotes；非法字数回退 3000', () => {
    const d = parseChapterDetailPayload({
      summary: '林岸夜访旧档案室，发现卷宗被换。',
      hooks: ['潜入档案室', '发现调包', '被保安发现'],
      targetWordCount: 3200,
      continuityNotes: ['承接第 30 章的车票线索'],
    })!
    expect(d).toMatchObject({
      summary: '林岸夜访旧档案室，发现卷宗被换。',
      targetWordCount: 3200,
      continuityNotes: ['承接第 30 章的车票线索'],
    })
    expect(d.hooks).toHaveLength(3)
    expect(parseChapterDetailPayload({ summary: 'x', hooks: ['a'], targetWordCount: 99 })!.targetWordCount).toBe(3000)
  })

  it('缺 summary 或 hooks 为空时拒绝解析', () => {
    expect(parseChapterDetailPayload({ hooks: ['a'] })).toBeNull()
    expect(parseChapterDetailPayload({ summary: 'x', hooks: [] })).toBeNull()
  })

  it('采纳只回写未写章；已写章（字数>0 / 磁盘有稿）拒绝', async () => {
    mockStore.chapters = [
      { id: 'u', volumeId: 'v1', order: 1, title: '未写', wordCount: 0, hooks: [] },
      { id: 'w', volumeId: 'v1', order: 2, title: '已写', wordCount: 5000, hooks: [] },
      { id: 'd', volumeId: 'v1', order: 3, title: '磁盘有稿', wordCount: 0, hooks: [] },
    ]
    mockStore.content['d'] = '磁盘正文'
    const detail = { summary: '摘要', hooks: ['钩子'], targetWordCount: 3000, continuityNotes: [] }

    expect(await applyChapterDetail('u', detail)).toBe(true)
    expect(await applyChapterDetail('w', detail)).toBe(false)
    expect(await applyChapterDetail('d', detail)).toBe(false)
    expect(await applyChapterDetail('ghost', detail)).toBe(false)
    expect(mockStore.chapterUpdates).toEqual([
      { id: 'u', patch: { summary: '摘要', hooks: ['钩子'], targetWordCount: 3000 } },
    ])
  })
})

describe('outline-planner · A5 大纲体检', () => {
  it('过滤非法 severity/type；已写章补丁被丢弃并计数', () => {
    const parsed = parseOutlineReviewPayload(
      {
        score: 72,
        summary: '前半节奏偏慢',
        issues: [
          {
            id: 'pacing-1',
            severity: 'warning',
            type: 'pacing',
            volumeOrder: 0,
            chapterOrder: 2,
            title: '连续两章低强度',
            description: '缺少冲突升级',
            suggestion: '提前引爆矛盾',
            patch: { hooks: ['提前摊牌'] },
          },
          {
            id: 'bad-severity',
            severity: 'fatal',
            type: 'logic',
            title: '应被丢弃',
            description: 'x',
            suggestion: 'y',
          },
          {
            id: 'written-patch',
            severity: 'info',
            type: 'repetition',
            chapterId: 'ch-written',
            title: '已写章补丁',
            description: 'x',
            suggestion: 'y',
            patch: { summary: '妄图改写' },
          },
        ],
      },
      {
        writtenIds: new Set(['ch-written', 'ch-u2']),
        resolveChapterId: (v, c) => (v === 0 && c === 1 ? 'ch-u2' : undefined),
      },
    )!
    expect(parsed.score).toBe(72)
    expect(parsed.issues.map((i) => i.id)).toEqual(['pacing-1', 'written-patch'])
    expect(parsed.issues[0].patch).toEqual({ summary: undefined, hooks: ['提前摊牌'] })
    expect(parsed.issues[1].patch).toBeUndefined()
    expect(parsed.skipped).toBe(1)
  })

  it('卷序/章序可反查章 id；应用补丁时再次拦截已写章', async () => {
    mockStore.chapters = [
      { id: 'a', volumeId: 'v1', order: 1, title: '未写A', wordCount: 0, hooks: [] },
      { id: 'b', volumeId: 'v1', order: 2, title: '未写B', wordCount: 0, hooks: [] },
      { id: 'w', volumeId: 'v1', order: 3, title: '已写', wordCount: 4000, hooks: [] },
    ]
    mockStore.content['b'] = '磁盘正文'
    const vols = [
      {
        vol: { id: 'v1', novelId: 'n1', title: '第一卷', order: 1, summary: '' },
        chapters: mockStore.chapters,
      },
    ] as any

    const issues = [
      { id: 'i1', severity: 'warning' as const, type: 'pacing' as const, volumeOrder: 0, chapterOrder: 0, title: 't', description: 'd', suggestion: 's', patch: { hooks: ['新钩'] } },
      { id: 'i2', severity: 'warning' as const, type: 'pacing' as const, volumeOrder: 0, chapterOrder: 1, title: 't', description: 'd', suggestion: 's', patch: { summary: '磁盘有稿不写' } },
      { id: 'i3', severity: 'warning' as const, type: 'pacing' as const, chapterId: 'w', title: 't', description: 'd', suggestion: 's', patch: { summary: '已写不写' } },
    ]
    expect(await applyReviewPatches(issues, vols)).toBe(1)
    expect(mockStore.chapterUpdates).toEqual([{ id: 'a', patch: { hooks: ['新钩'] } }])
  })
})

describe('outline-planner · A2 卷扩展字段落库', () => {
  it('goal / climax / endingHook / estimatedChapters / targetWordCount 随卷写入', async () => {
    mockStore.novel = { id: 'n1', title: '旧书名', description: '', genre: [] }
    await applyProspectiveOutline('n1', {
      confirmed: { title: '旧书名', genre: '', premise: '', characters: [], volumeCount: 1 },
      masterPlan: {
        masterOutline: '主线',
        volumes: [
          {
            title: '卷A',
            summary: '纲A',
            goal: '目标',
            climax: '高潮',
            endingHook: '钩子',
            estimatedChapters: 12,
            targetWordCount: 36000,
          },
        ],
      },
      firstVolumeChapters: [],
    })
    expect(mockStore.volumeCreates[0]).toMatchObject({
      title: '卷A',
      goal: '目标',
      climax: '高潮',
      endingHook: '钩子',
      estimatedChapters: 12,
      targetWordCount: 36000,
    })
  })

  it('确认立项携带世界观/基调时，一并落库为世界观条目', async () => {
    mockStore.novel = { id: 'n1', title: '书', description: '', genre: [] }
    await applyProspectiveOutline('n1', {
      confirmed: {
        title: '书',
        genre: '',
        premise: '',
        characters: [],
        volumeCount: 1,
        worldview: '力量体系：异能分五阶',
        setting: '雾港：常年大雾的沿海城',
        power: '金手指：看见三分钟后的死亡',
        tone: '冷峻',
      },
      masterPlan: { masterOutline: '主线', volumes: [{ title: '卷A', summary: '纲A' }] },
      firstVolumeChapters: [],
    })
    expect(mockStore.worldviewCreates.map((w) => w.title)).toEqual([
      '力量体系',
      '雾港',
      '金手指',
      '基调与读者',
    ])
  })
})

// ===== 采纳立项提案（规划页单步采纳）=====

describe('outline-planner · applySeedProposal', () => {
  it('只写变化的立项字段；类型已在库不重复追加；角色重名/空名跳过', async () => {
    mockStore.novel = { id: 'n1', title: '旧书名', description: '旧梗概', genre: ['悬疑'] }
    mockStore.characters = [{ id: 'c0', name: '江砚', role: 'protagonist', profile: '已有' }]

    const r = await applySeedProposal('n1', {
      title: '新书名',
      genre: '悬疑',
      premise: '新梗概',
      characters: [
        { name: '江砚', role: 'protagonist', profile: '重名应跳过' },
        { name: '  ', role: 'supporting', profile: '空名应跳过' },
        { name: '苏禾', role: 'supporting', profile: '新建' },
      ],
    })

    expect(r).toEqual({ title: true, genre: false, description: true, characters: 1, worldviews: 0 })
    expect(mockStore.novelUpdates).toEqual([{ title: '新书名', description: '新梗概' }])
    expect(mockStore.characterCreates).toHaveLength(1)
    expect(mockStore.characterCreates[0]).toMatchObject({ novelId: 'n1', name: '苏禾', role: 'supporting', profile: '新建' })
    // 有新建角色才同步角色档案；主线视图始终同步
    expect(mockStore.syncs).toEqual(['characters', 'outline'])
  })

  it('新类型追加到已有类型之后；全部无变化时不写库', async () => {
    mockStore.novel = { id: 'n1', title: '书', description: '梗概', genre: ['悬疑'] }

    const r = await applySeedProposal('n1', {
      title: '书',
      genre: '都市',
      premise: '梗概',
      characters: [],
    })

    expect(r).toEqual({ title: false, genre: true, description: false, characters: 0, worldviews: 0 })
    expect(mockStore.novelUpdates).toEqual([{ genre: ['悬疑', '都市'] }])
    expect(mockStore.characterCreates).toEqual([])
    expect(mockStore.syncs).toEqual(['outline'])
  })

  it('小说不存在时抛错，且不产生任何写入', async () => {
    await expect(
      applySeedProposal('ghost', { title: 't', genre: '', premise: '', characters: [] }),
    ).rejects.toThrow('未找到该小说')
    expect(mockStore.novelUpdates).toEqual([])
    expect(mockStore.syncs).toEqual([])
  })

  it('世界观与基调落库为世界观条目；同名跳过，不覆盖已有', async () => {
    mockStore.novel = { id: 'n1', title: '书', description: '', genre: [] }
    mockStore.worldviews = [{ id: 'w0', title: '雾港常年大雾', content: '旧内容' }]

    const r = await applySeedProposal('n1', {
      title: '书',
      genre: '',
      premise: '',
      characters: [],
      worldview: '力量体系：异能分五阶\n雾港常年大雾',
      tone: '冷峻',
      worldAnchors: ['典当行：记忆可被典当'],
    })

    expect(r.worldviews).toBe(3)
    expect(mockStore.worldviewCreates.map((w) => w.title)).toEqual(['力量体系', '典当行', '基调与读者'])
    expect(mockStore.worldviewCreates[0]).toMatchObject({ novelId: 'n1', category: 'other', content: '异能分五阶' })
  })
})

describe('outline-planner · seedWorldviewEntries', () => {
  it('按行拆分「标题：内容」，兼容列表符号；锚点与基调一并收录且同批去重', () => {
    const entries = seedWorldviewEntries({
      worldview: '- 力量体系：异能分五阶\n雾港常年大雾\n力量体系：重复标题应丢弃',
      worldAnchors: ['典当行：记忆可被典当'],
      tone: '冷峻悬疑，面向成年读者',
    })
    expect(entries).toEqual([
      { title: '力量体系', content: '异能分五阶' },
      { title: '雾港常年大雾', content: '雾港常年大雾' },
      { title: '典当行', content: '记忆可被典当' },
      { title: '基调与读者', content: '冷峻悬疑，面向成年读者' },
    ])
  })

  it('时代地点与金手指也拆成世界观条目', () => {
    const entries = seedWorldviewEntries({
      setting: '雾港：常年大雾的沿海城',
      power: '金手指：看见三分钟后的死亡',
    })
    expect(entries).toEqual([
      { title: '雾港', content: '常年大雾的沿海城' },
      { title: '金手指', content: '看见三分钟后的死亡' },
    ])
  })

  it('空输入返回空数组', () => {
    expect(seedWorldviewEntries({})).toEqual([])
    expect(seedWorldviewEntries({ worldview: ' \n - ', tone: '  ' })).toEqual([])
  })
})

// ===== 采纳卷章纲（只追加，不动已写章）=====

describe('outline-planner · applyVolumeChapters', () => {
  it('order 接在已有章之后；空章名/空骨架跳过；hooks 去空；字数越界回退 3000', async () => {
    mockStore.chapters = [
      { id: 'w', volumeId: 'v1', order: 2, title: '已写', wordCount: 5000, hooks: [] },
      { id: 'u', volumeId: 'v1', order: 5, title: '未写', wordCount: 0, hooks: [] },
      { id: 'other', volumeId: 'v2', order: 9, title: '他卷', wordCount: 0, hooks: [] },
    ]

    const n = await applyVolumeChapters('n1', 'v1', [
      { title: '第一章', hooks: [' 甲 ', '', '乙'] },
      { title: '  ', hooks: ['无题应跳过'] },
      { title: '第二章', hooks: [] },
      { title: '第三章', hooks: ['丙'], targetWordCount: 4500 },
      { title: '第四章', hooks: ['丁'], targetWordCount: 99 },
      { title: '第五章', hooks: ['戊'], targetWordCount: 25000 },
    ])

    expect(n).toBe(4)
    const created = mockStore.chapters.slice(3)
    expect(created.map((c) => ({ title: c.title, order: c.order, targetWordCount: c.targetWordCount, hooks: c.hooks }))).toEqual([
      { title: '第一章', order: 6, targetWordCount: 3000, hooks: ['甲', '乙'] },
      { title: '第三章', order: 7, targetWordCount: 4500, hooks: ['丙'] },
      { title: '第四章', order: 8, targetWordCount: 3000, hooks: ['丁'] },
      { title: '第五章', order: 9, targetWordCount: 3000, hooks: ['戊'] },
    ])
    expect(created[0]).toMatchObject({ volumeId: 'v1', wordCount: 0, status: 'draft', summary: '' })
    // 只新增，绝不改动任何已有章
    expect(mockStore.chapterUpdates).toEqual([])
    expect(mockStore.syncs).toEqual(['outline'])
  })

  it('全部骨架无效时不建章、不同步', async () => {
    mockStore.chapters = [{ id: 'w', volumeId: 'v1', order: 1, title: '已写', wordCount: 3000, hooks: ['旧'] }]

    const n = await applyVolumeChapters('n1', 'v1', [
      { title: '', hooks: ['x'] },
      { title: '无骨架', hooks: [] },
    ])

    expect(n).toBe(0)
    expect(mockStore.chapters).toHaveLength(1)
    expect(mockStore.chapterUpdates).toEqual([])
    expect(mockStore.syncs).toEqual([])
  })
})

describe('按作者样例二次改句（humanize）', () => {
  const seed = { title: '测试书', genre: '校园日常', premise: '林见和同桌一起经营旧书摊。' }
  const item = {
    text: '早读铃响，他把练习册推过去——同一道题，他记得是2，本子上写着3。',
    axis: '悬疑感',
    scene: '早读对练习册数字',
    functionPositions: ['可重复仪式'],
    whyItWorks: '每天对一次数字',
    risks: ['能力边界要写清'],
  }

  it('任务里带压缩版/人味版风格契约与事实约束', () => {
    const task = buildSeedHumanizeTask('premise', seed, [item])
    expect(task).toContain('人味版')
    expect(task).toContain('压缩版')
    expect(task).toContain('不对呀，这道题他做过')
    expect(task).toContain('把破折号压缩的长句拆成短句')
    expect(task).toContain('事实、人物、关系、数字、专有名词、引号里的内容必须原样保留')
    expect(task).toContain('不新增人物、地点、道具或事件')
    expect(task).toContain('不能新增句子、新事件或新道具')
    expect(task).toContain('保留原有落点与长短差')
    expect(task).toContain('不能停在「不对呀」这种半句上')
    expect(task).toContain('【悬疑感】')
    expect(task).toContain('items 数量与顺序必须和输入一一对应')
    expect(task).toContain('"suggestions":["改好的第 1 条","改好的第 2 条"]')
    expect(task).toContain('"field":"premise"')
  })

  it('只对叙事类字段启用二次改句', () => {
    expect(isHumanizeField('premise')).toBe(true)
    expect(isHumanizeField('coreConflict')).toBe(true)
    expect(isHumanizeField('protagonist')).toBe(true)
    expect(isHumanizeField('characters')).toBe(true)
    expect(isHumanizeField('sellingPoints')).toBe(true)
    expect(isHumanizeField('title')).toBe(false)
    expect(isHumanizeField('genre')).toBe(false)
    expect(isHumanizeField('worldview')).toBe(false)
  })

  it('事实守卫要求数字与引号原话保留', () => {
    expect(factTokens('他记得是2，本子上写着3；她说「别坐我旁边」。')).toEqual([
      '2',
      '3',
      '别坐我旁边',
    ])
    expect(humanizeKeepsFacts('他记得是2，本子上写着3。', '不对呀，他明明记得写的是2，本子上却是3。')).toBe(true)
    expect(humanizeKeepsFacts('他记得是2，本子上写着3。', '他明明记得写的是4，本子上却是3。')).toBe(false)
    expect(humanizeKeepsFacts('12个人', '2个人')).toBe(false)
    expect(humanizeKeepsFacts('她说「别坐我旁边」。', '她说别坐我后面。')).toBe(false)
    expect(humanizeKeepsFacts('他记得是2。', '他记得是2，桌上还多出3张纸。')).toBe(false)
    expect(
      humanizeKeepsFacts('她说「别坐我旁边」。', '她说「别坐我旁边」，又补了「我认真的」。'),
    ).toBe(false)
  })

  it('事实守卫阻止把改句扩写成新事件', () => {
    const original = '早读铃响他把练习册推过去，同桌没抬头，把橡皮掰成两半推回来，他翻开本子发现答案对不上。'
    const ballooned = original + '这时广播突然响起，全班被叫到操场，教导主任拿出一叠名单开始点名，谁也没再提那道题。'
    expect(humanizeKeepsFacts(original, ballooned)).toBe(false)
    expect(humanizeKeepsFacts(original, original.replace('推过去', '递过去'))).toBe(true)
  })

  it('合并只替换措辞，保留轴、场面、功能位与风险', () => {
    const merged = applyHumanizedItems(
      [item],
      [{ text: '早读铃响，他把练习册推过去。不对呀，他明明记得写的是2，本子上却是3。', whyItWorks: '每天对一次数字' }],
    )
    expect(merged).not.toBeNull()
    expect(merged![0]).toMatchObject({
      axis: '悬疑感',
      scene: '早读对练习册数字',
      functionPositions: ['可重复仪式'],
      risks: ['能力边界要写清'],
      whyItWorks: '每天对一次数字',
    })
    expect(merged![0]!.text).toContain('不对呀')
  })

  it('条数不一致或事实被改动时拒绝整批结果', () => {
    expect(applyHumanizedItems([item], [])).toBeNull()
    expect(
      applyHumanizedItems([item], [{ text: '早读铃响，他把练习册推过去，本子上写着3。' }]),
    ).toBeNull()
  })
})
