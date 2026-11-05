import { describe, it, expect } from 'vitest'
import type { StyleCraftData } from '@shared/style-types'
import {
  mergeStyleCraft,
  normalizeStyleCraft,
  normalizeVoices,
  redactCraftNames,
  voiceDispersion,
} from '@shared/style-craft'

describe('叙事工程层规范化', () => {
  it('只保留五个已知功能位，未知键与空描述被丢弃', () => {
    const craft = normalizeStyleCraft({
      functionPositions: [
        { key: 'repeatable_ritual', description: '每周固定在学校后门碰头', transferable: true, settingDependency: 'low' },
        { key: 'not_a_key', description: '非法功能位' },
        { key: 'intimate_excuse', description: '   ' },
      ],
    })!
    expect(craft.functionPositions).toHaveLength(1)
    expect(craft.functionPositions[0].key).toBe('repeatable_ritual')
  })

  it('场景去重、角色声音限长，空 craft 返回 null', () => {
    const craft = normalizeStyleCraft({
      sceneBank: [
        { scene: '教室后排递纸条', function: '推进关系', frequency: 3, transferable: true },
        { scene: '教室后排递纸条', function: '重复项', frequency: 9, transferable: true },
      ],
      voices: [
        {
          characterRole: '主角',
          sentenceAvgLen: 8,
          ellipsisPerChapter: 2,
          questionPerChapter: 1,
          exclaimPerChapter: 0,
          verbalTics: ['一', '二', '三', '四', '五', '六', '七'],
          tabooPhrases: [],
          evidence: [],
        },
      ],
    })!
    expect(craft.sceneBank).toHaveLength(1)
    expect(craft.sceneBank[0].frequency).toBe(3)
    expect(craft.voices[0].verbalTics).toHaveLength(6)
    expect(normalizeStyleCraft({ taboos: [], sceneBank: [] })).toBeNull()
  })

  it('角色声音离散度是句均长的变异系数', () => {
    expect(voiceDispersion([])).toBe(0)
    expect(voiceDispersion([{ characterRole: '甲', sentenceAvgLen: 10 } as never])).toBe(0)
    const voices = normalizeVoices([
      { characterRole: '主角', sentenceAvgLen: 10 },
      { characterRole: '搭档', sentenceAvgLen: 20 },
    ])
    expect(voiceDispersion(voices)).toBeCloseTo(0.33, 2)
  })
})

function craft(patch: Partial<StyleCraftData> = {}): StyleCraftData {
  return {
    functionPositions: [],
    sceneBank: [],
    voices: [],
    taboos: [],
    chapterEngineering: { openingPatterns: [], endingPatterns: [], titlePatterns: [] },
    relationshipEngine: [],
    plotEngine: [],
    comparison: [],
    ...patch,
  }
}

describe('多书叙事工程层合并', () => {
  it('功能位按 key 合并，可迁移性与设定依赖取更保守的一方', () => {
    const a = craft({
      functionPositions: [
        {
          key: 'repeatable_ritual',
          description: '每周固定碰头',
          evidence: ['甲'],
          transferable: true,
          settingDependency: 'low',
        },
      ],
    })
    const b = craft({
      functionPositions: [
        {
          key: 'repeatable_ritual',
          description: '依赖原书社团设定',
          evidence: ['乙'],
          transferable: false,
          settingDependency: 'high',
        },
      ],
    })
    const merged = mergeStyleCraft([
      { craft: a, weight: 3 },
      { craft: b, weight: 1 },
    ])!
    expect(merged.functionPositions).toHaveLength(1)
    expect(merged.functionPositions[0].description).toBe('每周固定碰头')
    expect(merged.functionPositions[0].transferable).toBe(false)
    expect(merged.functionPositions[0].settingDependency).toBe('high')
    expect(merged.functionPositions[0].evidence).toEqual(['甲', '乙'])
  })

  it('场景频次相加、禁忌与规则去重并集', () => {
    const a = craft({
      sceneBank: [{ scene: '教室后排递纸条', function: '推进关系', frequency: 2, transferable: true }],
      taboos: ['不写宿命代价'],
      chapterEngineering: { openingPatterns: ['直接进对话'], endingPatterns: [], titlePatterns: [] },
    })
    const b = craft({
      sceneBank: [{ scene: '教室后排递纸条', function: '', frequency: 3, transferable: true }],
      taboos: ['不写宿命代价', '不写倒计时'],
      chapterEngineering: { openingPatterns: ['直接进对话', '先写环境'], endingPatterns: [], titlePatterns: [] },
    })
    const merged = mergeStyleCraft([
      { craft: a, weight: 1 },
      { craft: b, weight: 1 },
    ])!
    expect(merged.sceneBank[0].frequency).toBe(5)
    expect(merged.taboos).toEqual(['不写宿命代价', '不写倒计时'])
    expect(merged.chapterEngineering.openingPatterns).toEqual(['直接进对话', '先写环境'])
  })

  it('高权重来源决定角色声音均值方向', () => {
    const a = craft({
      voices: [
        {
          characterRole: '主角',
          sentenceAvgLen: 10,
          ellipsisPerChapter: 2,
          questionPerChapter: 1,
          exclaimPerChapter: 0,
          verbalTics: ['才不是'],
          tabooPhrases: [],
          evidence: [],
        },
      ],
    })
    const b = craft({
      voices: [
        {
          characterRole: '主角',
          sentenceAvgLen: 20,
          ellipsisPerChapter: 4,
          questionPerChapter: 3,
          exclaimPerChapter: 2,
          verbalTics: ['随便'],
          tabooPhrases: [],
          evidence: [],
        },
      ],
    })
    const merged = mergeStyleCraft([
      { craft: a, weight: 3 },
      { craft: b, weight: 1 },
    ])!
    expect(merged.voices[0].sentenceAvgLen).toBeCloseTo(12.5, 1)
    expect(merged.voices[0].verbalTics).toEqual(['才不是', '随便'])
  })

  it('全部为空时返回 undefined', () => {
    expect(mergeStyleCraft([])).toBeUndefined()
    expect(mergeStyleCraft([{ craft: null, weight: 1 }])).toBeUndefined()
  })
})

describe('叙事工程层脱敏', () => {
  it('落库前把证据与描述里的真名替换为甲乙，结构字段不变', () => {
    const source = normalizeStyleCraft({
      functionPositions: [
        {
          key: 'visible_progress_bar',
          description: '用周野的排名做进度条',
          evidence: ['周野考了第8名'],
          transferable: true,
          settingDependency: 'low',
        },
      ],
      voices: [
        {
          characterRole: '主角',
          sentenceAvgLen: 8,
          ellipsisPerChapter: 1,
          questionPerChapter: 1,
          exclaimPerChapter: 0,
          verbalTics: ['沈溪说的'],
          tabooPhrases: [],
          evidence: ['沈溪笑了'],
        },
      ],
    })!
    const redacted = redactCraftNames(source, ['周野', '沈溪'])!
    const json = JSON.stringify(redacted)
    expect(json).not.toContain('周野')
    expect(json).not.toContain('沈溪')
    expect(redacted.functionPositions[0].description).toBe('用甲的排名做进度条')
    expect(redacted.functionPositions[0].evidence[0]).toBe('甲考了第8名')
    expect(redacted.voices[0].verbalTics[0]).toBe('乙说的')
    expect(redacted.voices[0].sentenceAvgLen).toBe(8)
  })

  it('长名优先替换，避免被短名截断；无实体时原样返回', () => {
    const source = normalizeStyleCraft({
      functionPositions: [
        {
          key: 'repeatable_ritual',
          description: '小满公主和周野的固定仪式',
          evidence: [],
          transferable: true,
          settingDependency: 'low',
        },
      ],
    })!
    const redacted = redactCraftNames(source, ['周野', '小满公主'])!
    expect(redacted.functionPositions[0].description).toBe('乙和甲的固定仪式')
    expect(redactCraftNames(source, [])).toEqual(source)
  })
})
