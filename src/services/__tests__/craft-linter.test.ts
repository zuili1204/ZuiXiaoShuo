import { describe, it, expect } from 'vitest'
import { computeStyleMetrics, zeroAxes } from '@shared/style-metrics'
import { lintCraft } from '../craft-linter'

const target = {
  ...zeroAxes(),
  openingInMediaResPct: 80,
  endingMedianLen: 12,
  endingShortImagePct: 60,
  hookEndingPct: 80,
  questionPerChapter: 2,
  ellipsisPerChapter: 3,
  dialogueAvgLen: 10,
  tabooRatio: 0.05,
  titleNamePct: 50,
}

describe('叙事工程体检', () => {
  it('对话直入场景 + 短画面收尾时结构得分高', () => {
    const text = '“走吧。”他说。\n零件盒还在桌上。'
    const result = lintCraft({ metrics: computeStyleMetrics(text), target })
    const structure = result.dimensions.find((d) => d.key === 'structure')!
    expect(structure.score).toBe(100)
    expect(result.dimensions.find((d) => d.key === 'taboo')!.score).toBe(100)
  })

  it('环境起笔 + 总结升华 + 苦情模板会拉低结构、钩子与禁忌分', () => {
    const bad = '天渐渐黑了下来。\n他知道，这一切都是宿命，代价是失去她，这是注定的。'
    const result = lintCraft({ metrics: computeStyleMetrics(bad), target })
    const score = (key: string) => result.dimensions.find((d) => d.key === key)!.score
    expect(score('structure')).toBeLessThan(100)
    expect(score('hook')).toBeLessThan(100)
    expect(score('taboo')).toBe(25)
    expect(result.findings.some((f) => f.dimension === '结构像')).toBe(true)
    expect(result.findings.some((f) => f.dimension === '禁忌像')).toBe(true)
    expect(result.score).toBeLessThan(70)
  })

  it('标题缺角色名时给出可执行修法', () => {
    const text = '“走吧。”他说。\n零件盒还在桌上。'
    const result = lintCraft({
      metrics: computeStyleMetrics(text),
      target,
      title: '第一章 雪夜',
      entityNames: ['林川'],
    })
    expect(result.dimensions.find((d) => d.key === 'structure')!.score).toBe(90)
    const fix = result.findings.find((f) => f.dimension === '结构像')
    expect(fix?.message).toContain('标题')
  })

  it('角色声音按句均长比对，偏差过大给修复提示', () => {
    const text = '“今天放学以后，我们一起去学校后面的那条街看看新开的店吧。”他说。'
    const result = lintCraft({
      metrics: computeStyleMetrics(text),
      target,
      craft: {
        functionPositions: [],
        sceneBank: [],
        voices: [
          {
            characterRole: '主角',
            sentenceAvgLen: 8,
            ellipsisPerChapter: 1,
            questionPerChapter: 1,
            exclaimPerChapter: 0,
            verbalTics: [],
            tabooPhrases: [],
            evidence: [],
          },
        ],
        taboos: [],
        chapterEngineering: { openingPatterns: [], endingPatterns: [], titlePatterns: [] },
        relationshipEngine: [],
        plotEngine: [],
        comparison: [],
      },
    })
    const character = result.dimensions.find((d) => d.key === 'character')!
    expect(character.score).toBeLessThan(50)
    expect(result.findings.some((f) => f.dimension === '角色像')).toBe(true)
  })

  it('分项权重合计为 1 且总分为加权结果', () => {
    const result = lintCraft({ metrics: computeStyleMetrics('“走吧。”他说。\n桌上有半块橡皮。'), target })
    expect(result.dimensions).toHaveLength(4)
    const weighted = result.dimensions.reduce((sum, d) => {
      const weight = { structure: 0.3, character: 0.2, hook: 0.25, taboo: 0.25 }[d.key as 'structure'] ?? 0
      return sum + d.score * weight
    }, 0)
    expect(Math.round(weighted)).toBe(result.score)
  })
})
