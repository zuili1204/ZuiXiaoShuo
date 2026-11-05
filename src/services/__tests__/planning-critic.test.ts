import { describe, expect, it } from 'vitest'
import {
  critiquePlan,
  critiqueText,
  evaluateSuggestions,
  FUNCTION_POSITIONS,
  scoreSuggestion,
} from '../planning-critic'

describe('planning-critic · 整份方案体检', () => {
  const badPlan = [
    { location: '第1章', text: '他走进教室，暗下决心。' },
    { location: '第2章', text: '他看见同桌，暗下决心。' },
    { location: '第3章', text: '他回到家，暗下决心。' },
    { location: '第4章', text: '他站在天台，暗下决心。' },
  ]

  it('多个落点停在决心上时报 blocking，并带位置与原文', () => {
    const result = critiquePlan(badPlan)
    const finding = result.findings.find((f) => f.code === 'plan-ending-summary')
    expect(finding?.severity).toBe('blocking')
    expect(finding?.location).toContain('第1章')
    expect(finding?.evidence).toContain('暗下决心')
  })

  it('跨块重复短语会报位置', () => {
    const result = critiquePlan([
      { location: '第1章', text: '她把伞塞给他，转身跑进雨里。' },
      { location: '第2章', text: '她把伞塞给他，自己留在站台。' },
      { location: '第3章', text: '她把伞塞给他，说下次别忘。' },
    ])
    const finding = result.findings.find((f) => f.code === 'plan-repeated-phrase')
    expect(finding).toBeTruthy()
    expect(finding?.location).toContain('第1章')
  })

  it('没有人做选择时报告决策密度', () => {
    const result = critiquePlan([
      { location: '第1章', text: '下雨了。教室里很安静。' },
      { location: '第2章', text: '天晴了。操场上很热闹。' },
      { location: '第3章', text: '放学了。校门口人很多。' },
    ])
    expect(result.metrics.decisionDensity).toBe(0)
    expect(result.findings.some((f) => f.code === 'plan-decision-sparse')).toBe(true)
  })

  it('选择动作会计入决策密度', () => {
    const result = critiquePlan([
      { location: '第1章', text: '她把伞塞给他，转身跑进雨里。' },
      { location: '第2章', text: '他退回了同桌的旧书，留到放学。' },
      { location: '第3章', text: '她关掉台灯，走出门。' },
    ])
    expect(result.metrics.decisionDensity).toBe(1)
  })

  it('组队、立规矩、拉人入伙这类带后果的行动也算选择', () => {
    const result = critiquePlan([
      { location: '候选1', text: '为了不露馅，他拉上同桌和两个社团同学，组了个每天对暗号的晨会。' },
      { location: '候选2', text: '为了守住秘密，四个人立了本共用账本。' },
      { location: '候选3', text: '他只想安静修表，混过高三。' },
    ])
    expect(result.metrics.decisionDensity).toBeCloseTo(0.67)
    expect(result.findings.some((f) => f.code === 'plan-decision-sparse')).toBe(false)
  })

  it('原文片段不会只截到结尾的引号', () => {
    const result = critiquePlan([
      { location: '第1章', text: '雨下了一整夜，教室里没人说话。「明天再说。」' },
      { location: '第2章', text: '天亮了，操场上很安静。「先回去吧。」' },
      { location: '第3章', text: '放学了，校门口人很多。「明天见。」' },
    ])
    const finding = result.findings.find((f) => f.code === 'plan-decision-sparse')
    expect(finding?.evidence).toBeTruthy()
    expect(finding?.evidence).not.toBe('」')
    expect((finding?.evidence ?? '').length).toBeGreaterThanOrEqual(4)
  })

  it('当场换手、换说法这类掩饰动作也算选择', () => {
    const result = critiquePlan([
      { location: '候选1', text: '他摸出钥匙，左边兜是空的；被人盯着看，他把钥匙换到右手。' },
      { location: '候选2', text: '雨下了一整夜，教室里没人说话。' },
      { location: '候选3', text: '放学了，校门口人很多。' },
    ])
    expect(result.metrics.decisionDensity).toBeCloseTo(0.33)
  })

  it('约定类互相承诺也算明确选择', () => {
    const result = critiquePlan([
      { location: '候选1', text: '两人约定每天六点半在河堤对暗号。' },
      { location: '候选2', text: '他只想安静修表，混过高三。' },
      { location: '候选3', text: '雨下了一整夜，教室里没人说话。' },
    ])
    expect(result.metrics.decisionDensity).toBeCloseTo(0.33)
  })

  it('每条整体发现都带一句可执行的改法', () => {
    const result = critiquePlan(badPlan)
    expect(result.findings.length).toBeGreaterThan(0)
    for (const finding of result.findings) {
      expect(finding.suggestion?.trim()).toBeTruthy()
    }
  })

  it('多个块都用人物档案体时提升为整份问题', () => {
    const result = critiquePlan([
      { location: '主角', text: '主角：功能 搞事 / 缺口 缺爱 / 关系标签 债主' },
      { location: '配角', text: '配角：功能 吐槽 / 缺口 嘴硬 / 关系标签 常客' },
    ])
    expect(result.findings.some((f) => f.code === 'plan-dossier-cross')).toBe(true)
  })

  it('结构分散的方案得分高于落点同型的方案', () => {
    const good = [
      { location: '第1章', text: '她把纸推回去，说这次免费。' },
      { location: '第2章', text: '他追到楼梯口，只捡到一只拖鞋。' },
      { location: '第3章', text: '班主任合上记录本，笔还夹在页间。' },
      { location: '第4章', text: '她把五块钱塞进他口袋，转身走了。' },
    ]
    expect(critiquePlan(good).score).toBeGreaterThan(critiquePlan(badPlan).score)
  })

  it('长文本字段自动附带整份体检，短字段不附带', () => {
    const items = [
      { text: '她把伞塞给他，转身跑进雨里。', axis: '日常' },
      { text: '他把伞塞给她，自己留在站台。', axis: '关系' },
      { text: '她把伞塞给猫，转身跑了。', axis: '喜剧' },
    ]
    expect(evaluateSuggestions(items, 'premise').planCritique?.metrics.blockCount).toBe(3)
    expect(evaluateSuggestions([{ text: '夏夜' }, { text: '雨巷' }], 'title').planCritique).toBeUndefined()
  })
})

describe('planning-critic · 模板检测', () => {
  it('命中代价/宿命/对称结构时判 blocking', () => {
    const c = critiqueText('他必须在救人的同时付出代价，这是宿命。', 'premise')
    expect(c.blocking).toBeGreaterThanOrEqual(2)
    expect(c.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['cost-template', 'fate-words', 'symmetry-template']),
    )
    expect(c.freshness).toBeLessThan(50)
  })

  it('具体场面的建议不命中 blocking，且具体信息更多', () => {
    const c = critiqueText('他把伞塞给她，转身跑进雨里，校门口的猫叫了一声。', 'premise')
    expect(c.blocking).toBe(0)
    expect(c.concrete).toBeGreaterThan(0)
    expect(c.freshness).toBeGreaterThan(80)
  })

  it('全是抽象词、没有落地信息时判不可写', () => {
    const c = critiqueText('关于成长、救赎与羁绊的温暖故事，充满勇气与守护。', 'premise')
    expect(c.findings.some((f) => f.code === 'abstract-only')).toBe(true)
    expect(c.blocking).toBeGreaterThan(0)
  })

  it('不同字段套用不同的模板规则（书名不检查代价模板）', () => {
    const c = critiqueText('代价', 'title')
    expect(c.findings.some((f) => f.code === 'cost-template')).toBe(false)
  })
})

describe('planning-critic · 人物档案体', () => {
  const dossier =
    '林见（主角）—— 功能：店长 / 缺口：缺钱 / 关系标签：债主 / 口头禅：修表\n沈晴（配角）—— 功能：搞事 / 缺口：嘴硬 / 关系标签：常客 / 口头禅：才不是'
  const prose =
    '沈晴把修理费压在零件盒底下，说这是这个月第三次修；林见数完才发现少了两块，追到楼道只捡到她落下的一只拖鞋。'

  it('字段清单 / 破折号排比在人物块判 blocking', () => {
    const c = critiqueText(dossier, 'characters')
    const finding = c.findings.find((f) => f.code === 'dossier-template')
    expect(finding?.severity).toBe('blocking')
    expect(c.blocking).toBeGreaterThan(0)
    expect(c.freshness).toBeLessThan(60)
  })

  it('同样文本放在世界观块只算 warning，不阻断', () => {
    const c = critiqueText(dossier, 'worldview')
    expect(c.findings.find((f) => f.code === 'dossier-template')?.severity).toBe('warning')
  })

  it('场面化写法不命中档案体规则', () => {
    const c = critiqueText(prose, 'characters')
    expect(c.findings.some((f) => f.code === 'dossier-template')).toBe(false)
    expect(c.blocking).toBe(0)
  })

  it('识别身份标签堆叠与同一套人物公式', () => {
    const text =
      '沈晴（常客 · 姐姐 · 邻居）：她修表时先递收据，麻烦是她太慢热，一沉默就退回顾客与店家。\n' +
      '陆知夏（同桌 · 病娇 · 大小姐）：她切橡皮，她越界的方式是堵在楼梯口。\n' +
      '陈夏（青梅 · 运动系）：她抛豆浆，她越界的方式是替他答到。'
    const c = critiqueText(text, 'characters')
    expect(c.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(['tag-stack', 'formula-repeat']),
    )
  })

  it('不对称的场面写法不触发公式与标签规则', () => {
    const c = critiqueText(
      '沈晴把收据说成零件费，说到第三遍才肯进门；林见数完螺丝才发现少了半盒。陆知夏只把半块橡皮推过来，没说话。',
      'characters',
    )
    expect(c.findings.map((f) => f.code)).not.toEqual(
      expect.arrayContaining(['tag-stack', 'formula-repeat', 'uniform-lines']),
    )
  })

  it('场面化写法的人物建议得分高于档案体', () => {
    const scene = '旧钟表铺柜台，修理费压在零件盒底下'
    const bad = scoreSuggestion({ text: dossier, axis: '轻喜剧', scene }, 'characters')
    const good = scoreSuggestion({ text: prose, axis: '轻喜剧', scene }, 'characters')
    expect(good.overall).toBeGreaterThan(bad.overall)
    expect(good.fit).toBeGreaterThan(bad.fit)
  })
})

describe('planning-critic · 评分与体检', () => {
  const field = 'premise' as const

  it('有场面、有可重复标记的建议分数更高', () => {
    const good = scoreSuggestion(
      {
        text: '每周日他都去旧货市场摆摊，两元一次帮人修表，直到遇见一块停在十二点的怀表。',
        axis: '日常仪式',
        scene: '旧货市场门口的小桌，周日固定开张',
        functionPositions: ['可重复仪式'],
      },
      field,
    )
    const bad = scoreSuggestion(
      { text: '一个关于成长、救赎与宿命的温暖故事。', axis: '宿命' },
      field,
    )
    expect(good.overall).toBeGreaterThan(bad.overall)
    expect(good.writability).toBeGreaterThan(bad.writability)
  })

  it('汇总指标包含模板化、场面数、轴多样性与功能位覆盖', () => {
    const result = evaluateSuggestions(
      [
        {
          text: '两元一次的修表摊，每周日在校门口开张，直到班主任来排队。',
          axis: '日常仪式',
          scene: '校门口的小摊，班主任排在第三个',
          functionPositions: [FUNCTION_POSITIONS[1]],
        },
        {
          text: '他能修好任何旧钟表，却唯独修不好同桌的那只。',
          axis: '关系流',
          scene: '早读时同桌把一只停走的怀表推过来',
          functionPositions: [FUNCTION_POSITIONS[0], FUNCTION_POSITIONS[2]],
        },
      ],
      field,
    )
    expect(result.items).toHaveLength(2)
    expect(result.summary.metrics.sceneCount).toBe(2)
    expect(result.summary.metrics.axisDiversity).toBe(1)
    expect(result.summary.metrics.functionPositionCoverage).toBe(0.6)
    expect(result.summary.score).toBeGreaterThan(0)
  })

  it('重复的 finding 会去重', () => {
    const result = evaluateSuggestions(
      [
        { text: '这是宿命，也是宿命。', axis: 'a' },
        { text: '代价是代价。', axis: 'b' },
      ],
      field,
    )
    const codes = result.summary.findings.map((f) => `${f.code}:${f.message}`)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
