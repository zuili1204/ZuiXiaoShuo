import { describe, it, expect } from 'vitest'
import type {
  MergedStyleProfile,
  StyleAnchor,
  StyleAxes,
  StyleCraftData,
  StyleProfile,
  StyleProfileData,
  StyleRecipe,
} from '@shared/style-types'
import { blendStyles, blendAxes, mergeRules, selectAnchors, voteCategorical, type BlendSourceInput } from '../style-blend-service'
import { renderStylePrompt, stylePromptBudget } from '../style-prompt-service'
import { adherenceOf, buildFindings, scoreDimensions, weightedStyleScore } from '../style-eval-service'
import { metricsToAxes, type StyleMetrics } from '@shared/style-metrics'

function axes(patch: Partial<StyleAxes> = {}): StyleAxes {
  return {
    sentenceAvgLen: 12,
    shortSentencePct: 40,
    longSentencePct: 5,
    paragraphAvgLen: 60,
    dialoguePct: 25,
    dialogueAvgLen: 10,
    shortReplyPct: 60,
    simileStrictPer1k: 2,
    dashPerChapter: 3,
    interiorityPct: 12,
    sensoryPer1k: 4,
    colloquialPct: 20,
    hookEndingPct: 80,
    infoHookPer1k: 5,
    chapterAvgLen: 3000,
    ellipsisPerChapter: 3,
    questionPerChapter: 2,
    exclaimPerChapter: 1,
    shortParagraphPct: 30,
    parentheticalPerChapter: 0.2,
    openingDialoguePct: 40,
    openingContinuationPct: 35,
    openingInMediaResPct: 75,
    endingMedianLen: 14,
    endingShortImagePct: 55,
    titleNamePct: 45,
    titleExclaimPct: 4,
    titleQuestionPct: 3,
    titleMultiPartPct: 15,
    concreteObjectPer1k: 3,
    explanationPer1k: 0.5,
    publicEventPerChapter: 0.7,
    resetPerVolume: 0.5,
    tabooRatio: 0.05,
    characterVoiceDispersion: 0.25,
    ...patch,
  }
}

function profile(id: string, opts: {
  sourceId?: string
  confidence?: number
  axes?: Partial<StyleAxes>
  pov?: StyleProfileData['categorical']['pov']
  rules?: StyleProfileData['rules']
  anchors?: string[]
} = {}): StyleProfile {
  const payload: StyleProfileData = {
    schemaVersion: '1.0',
    metricVersion: 'p2-1.0',
    summary: '冷峻短句，对话克制',
    axes: axes(opts.axes),
    categorical: { pov: opts.pov ?? 'third_limited', tense: 'past', tone: '冷峻', register: '书面' },
    dimensions: [
      { key: 'syntax', value: '短句为主', confidence: 0.8, evidence: [] },
      { key: 'dialogue', value: '对话推进', confidence: 0.6, evidence: [] },
    ],
    rules: opts.rules ?? {
      do: [
        { text: '多用短句收束段落', confidence: 0.9 },
        { text: '对话后不解释潜台词', confidence: 0.8 },
      ],
      dont: [{ text: '避免连续三个比喻', confidence: 0.8 }],
    },
    lexicon: { preferred: ['铁锈味'], avoid: ['仿佛', '突然'] },
    sourceEntities: ['林川', '北城'],
    sampleStats: { totalChapters: 30, sampledChapters: 12, sampledChars: 30000, model: 'm', promptVersion: 'p2-1.0' },
    confidence: opts.confidence ?? 0.8,
  }
  return {
    id: `p_${id}`,
    sourceId: opts.sourceId ?? id,
    version: 1,
    status: 'ready',
    confidence: payload.confidence,
    model: 'm',
    promptVersion: 'p2-1.0',
    contentHash: 'h',
    payload,
    metrics: {},
    sampleStats: payload.sampleStats,
    createdAt: '',
    updatedAt: '',
  }
}

function recipe(patch: Partial<StyleRecipe> = {}): StyleRecipe {
  return {
    id: 'rec_1',
    name: '冷峻融合',
    strength: 70,
    povPolicy: 'follow_novel',
    povOverride: null,
    anchorMode: 'excerpt',
    anchorBudget: 300,
    items: [
      { sourceId: 'a', profileId: 'p_a', weight: 1 },
      { sourceId: 'b', profileId: 'p_b', weight: 1 },
    ],
    dimensionWeights: {},
    extraRules: [],
    overridesJson: {},
    status: 'ready',
    createdAt: '',
    updatedAt: '',
    ...patch,
  }
}

function anchor(id: string, text = '他推门而入，雪落在肩上。'): StyleAnchor {
  return {
    id,
    profileId: 'p_a',
    kind: 'action',
    text,
    charCount: text.length,
    chapterIndex: 1,
    quality: 0.8,
    origin: 'excerpt',
    createdAt: '',
  }
}

function sources(): BlendSourceInput[] {
  return [
    { sourceId: 'a', name: '甲书', profile: profile('a', { axes: { sentenceAvgLen: 10 } }), anchors: [anchor('a1'), anchor('a2')] },
    { sourceId: 'b', name: '乙书', profile: profile('b', { axes: { sentenceAvgLen: 20 } }), anchors: [anchor('b1'), anchor('b2')] },
  ]
}

describe('多书文风融合', () => {
  it('数值轴按来源权重加权平均', () => {
    const r = recipe({ items: [
      { sourceId: 'a', profileId: 'p_a', weight: 1 },
      { sourceId: 'b', profileId: 'p_b', weight: 3 },
    ] })
    const { axes: merged } = blendAxes(sources(), r)
    expect(merged.sentenceAvgLen).toBeCloseTo(17.5, 1)
  })

  it('维度覆盖权重优先于全局权重', () => {
    const r = recipe({ dimensionWeights: { syntax: { b: 0 } } })
    const { axes: merged } = blendAxes(sources(), r)
    expect(merged.sentenceAvgLen).toBeCloseTo(10, 1)
  })

  it('规则按支持度分级，低支持规则被丢弃', () => {
    const a = profile('a')
    const b = profile('b', {
      rules: {
        do: [
          { text: '多用短句收束段落。', confidence: 0.9 },
          { text: '只在乙书出现的规则', confidence: 0.9 },
        ],
        dont: [],
      },
    })
    const { do: doRules } = mergeRules(
      [{ sourceId: 'a', name: '甲', profile: a, anchors: [] }, { sourceId: 'b', name: '乙', profile: b, anchors: [] }],
      recipe(),
    )
    const shared = doRules.find((r) => r.text.includes('短句'))
    const single = doRules.find((r) => r.text.includes('只在乙书'))
    expect(shared?.tier).toBe('must')
    expect(single?.tier).toBe('should')
  })

  it('人称不一致时记录冲突，跟随本书策略不覆盖', () => {
    const src = [
      { sourceId: 'a', name: '甲', profile: profile('a', { pov: 'first' }), anchors: [] },
      { sourceId: 'b', name: '乙', profile: profile('b', { pov: 'third_limited' }), anchors: [] },
    ]
    const vote = voteCategorical(src, recipe(), 'pov')
    expect(vote.conflict).toBeTruthy()
    const merged = blendStyles(recipe(), src)
    expect(merged.conflicts.some((c) => c.kind === 'pov')).toBe(true)
  })

  it('配方指定人称时覆盖投票结果', () => {
    const merged = blendStyles(recipe({ povPolicy: 'follow_recipe', povOverride: 'first' }), sources())
    expect(merged.categorical.pov).toBe('first')
  })

  it('锚点受名额与字数预算双重约束', () => {
    const picked = selectAnchors(sources(), recipe({ anchorBudget: 300 }))
    expect(picked.length).toBeLessThanOrEqual(4)
    expect(picked.reduce((s, a) => s + a.charCount, 0)).toBeLessThanOrEqual(300)
  })

  it('抽象锚点模式不注入原文', () => {
    expect(selectAnchors(sources(), recipe({ anchorMode: 'abstract' }))).toEqual([])
  })

  it('融合输出包含手写规则与来源诊断', () => {
    const merged = blendStyles(recipe({ extraRules: ['不写系统面板'] }), sources())
    expect(merged.extraRules).toEqual(['不写系统面板'])
    expect(merged.mergedFrom.map((m) => m.weight)).toEqual([1, 1])
    expect(merged.sourceEntities).toContain('林川')
  })

  it('融合叙事工程层，并在写作提示词中单独注入', () => {
    const craftA: StyleCraftData = {
      functionPositions: [
        {
          key: 'repeatable_ritual',
          description: '每周固定在同一地点碰头',
          evidence: ['甲书原文'],
          transferable: true,
          settingDependency: 'low',
        },
      ],
      sceneBank: [{ scene: '教室后排递纸条', function: '推进关系', frequency: 2, transferable: true }],
      voices: [
        {
          characterRole: '主角',
          sentenceAvgLen: 8,
          ellipsisPerChapter: 2,
          questionPerChapter: 1,
          exclaimPerChapter: 0,
          verbalTics: ['才不是'],
          tabooPhrases: [],
          evidence: [],
        },
      ],
      taboos: ['不写宿命代价'],
      chapterEngineering: { openingPatterns: ['直接进对话'], endingPatterns: ['停在画面上'], titlePatterns: ['角色名+事件'] },
      relationshipEngine: ['先互怼后靠近'],
      plotEngine: ['公共事件制造独处'],
      comparison: [],
    }
    const a = profile('a')
    a.payload = { ...a.payload, schemaVersion: '2.0', craft: craftA }
    const b = profile('b')
    b.payload = {
      ...b.payload,
      schemaVersion: '2.0',
      craft: { ...craftA, taboos: ['不写宿命代价', '不写倒计时'] },
    }
    const merged = blendStyles(recipe(), [
      { sourceId: 'a', name: '甲书', profile: a, anchors: [] },
      { sourceId: 'b', name: '乙书', profile: b, anchors: [] },
    ])
    expect(merged.craft?.functionPositions).toHaveLength(1)
    expect(merged.craft?.taboos).toEqual(['不写宿命代价', '不写倒计时'])

    const prompt = renderStylePrompt({ ...merged, strength: 85 })!
    expect(prompt.text).toContain('叙事工程')
    expect(prompt.text).toContain('可重复仪式')
    expect(prompt.text).toContain('不写倒计时')
    expect(prompt.text.length).toBeLessThanOrEqual(stylePromptBudget(85))
  })
})

describe('文风提示词渲染', () => {
  const merged = (): MergedStyleProfile => blendStyles(recipe({ extraRules: ['不写系统面板'] }), sources())

  it('强度 0 不注入', () => {
    expect(renderStylePrompt({ ...merged(), strength: 0 })).toBeNull()
    expect(renderStylePrompt(null)).toBeNull()
  })

  it('低强度只给规则，不含量化目标与锚点', () => {
    const prompt = renderStylePrompt({ ...merged(), strength: 25 })!
    expect(prompt.text).toContain('## 文风目标（只影响表达方式）')
    expect(prompt.text).toContain('不写系统面板')
    expect(prompt.text).not.toContain('量化目标')
    expect(prompt.text).not.toContain('风格锚点')
  })

  it('中高强度含量化目标与锚点，且不超预算', () => {
    const prompt = renderStylePrompt({ ...merged(), strength: 85 })!
    expect(prompt.text).toContain('量化目标')
    expect(prompt.text).toContain('风格锚点')
    expect(prompt.text).toContain('少用词汇')
    expect(prompt.text.length).toBeLessThanOrEqual(stylePromptBudget(85))
    expect(prompt.meta.sourceNames).toEqual(['甲书', '乙书'])
  })
})

describe('生成后文风评估', () => {
  it('adherence 按容差线性衰减并截断到 0~1', () => {
    expect(adherenceOf(12, 12, 5)).toBe(1)
    expect(adherenceOf(15, 12, 6)).toBe(0.5)
    expect(adherenceOf(40, 12, 6)).toBe(0)
    expect(adherenceOf(8, 12, 0)).toBe(0)
  })

  it('维度贴合度按权重汇总为百分制', () => {
    const target = axes()
    const dimensions = scoreDimensions(target, target)
    expect(dimensions).toHaveLength(6)
    expect(weightedStyleScore(dimensions)).toBe(100)

    const drifted = scoreDimensions(axes({ sentenceAvgLen: 40, dialoguePct: 2 }), target)
    expect(weightedStyleScore(drifted)).toBeLessThan(100)
  })

  it('偏离维度与相似度命中都转为可读提示', () => {
    const dimensions = scoreDimensions(axes({ sentenceAvgLen: 40 }), axes())
    const findings = buildFindings(dimensions, {
      ngramRate: 20,
      longestCommon: 60,
      blocking: 1,
      advisory: 0,
      hits: [{ kind: 'ngram', value: '片段', severity: 'blocking', detail: '与来源重合度过高' }],
    })
    expect(findings.some((f) => f.dimension === '句法节奏' && f.severity === 'advisory')).toBe(true)
    expect(findings.some((f) => f.severity === 'blocking')).toBe(true)
  })

  it('指标轴可直接来自单章正文', () => {
    const actual = metricsToAxes({ ...measure('他推门而入。“来了？”她问。') })
    expect(actual.chapterAvgLen).toBeGreaterThan(0)
  })
})

function measure(text: string): StyleMetrics {
  // 避免测试直接依赖具体指标实现，仅用于构造合法单章轴
  return {
    chars: text.replace(/\s/g, '').length,
    sentenceCount: 2,
    sentenceAvgLen: 5,
    shortSentencePct: 100,
    longSentencePct: 0,
    paragraphCount: 2,
    paragraphAvgLen: 20,
    dialogueChars: 4,
    dialogueCount: 1,
    dialoguePct: 20,
    dialogueAvgLen: 4,
    shortReplyPct: 100,
    similePer1k: 0,
    simileStrictPer1k: 0,
    dashCount: 0,
    interiorityPct: 0,
    sensoryPer1k: 0,
    colloquialPct: 0,
    infoHookPer1k: 0,
    hookEnding: false,
    ellipsisCount: 0,
    questionCount: 1,
    exclaimCount: 0,
    shortParagraphCount: 1,
    parentheticalCount: 0,
    openingType: 'dialogue',
    endingLen: 5,
    endingType: 'image',
    concreteObjectHits: 1,
    explanationCount: 0,
    publicEventHits: 0,
    resetHits: 0,
    tabooHits: 0,
  }
}
