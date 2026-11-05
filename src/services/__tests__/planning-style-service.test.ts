import { describe, expect, it } from 'vitest'
import type { MergedStyleProfile } from '@shared/style-types'
import {
  MODERN_SERIAL_BASELINE,
  planningCraftSection,
  renderAuthorAnchors,
  renderCraftCard,
} from '../planning-style-service'

function profile(): MergedStyleProfile {
  return {
    recipeId: 'rec_1',
    recipeName: '校园轻喜剧',
    strength: 60,
    anchorMode: 'excerpt',
    sourceNames: ['示例作品'],
    summary: '朋友式限知视角，短段短句，公共事件里写私人反应。',
    axes: {
      sentenceAvgLen: 14,
      shortSentencePct: 46,
      longSentencePct: 6,
      paragraphAvgLen: 22,
      dialoguePct: 48,
      dialogueAvgLen: 13,
      shortReplyPct: 55,
      simileStrictPer1k: 0.6,
      dashPerChapter: 0.3,
      interiorityPct: 12,
      sensoryPer1k: 1.2,
      colloquialPct: 61,
      hookEndingPct: 79,
      infoHookPer1k: 1.1,
      chapterAvgLen: 2600,
      ellipsisPerChapter: 4.2,
      questionPerChapter: 2.1,
      exclaimPerChapter: 1.4,
      shortParagraphPct: 38,
      parentheticalPerChapter: 0.4,
      openingDialoguePct: 41,
      openingContinuationPct: 38,
      openingInMediaResPct: 79,
      endingMedianLen: 13,
      endingShortImagePct: 62,
      titleNamePct: 49,
      titleExclaimPct: 4,
      titleQuestionPct: 3,
      titleMultiPartPct: 18,
      concreteObjectPer1k: 3.2,
      explanationPer1k: 0.4,
      publicEventPerChapter: 0.8,
      resetPerVolume: 0.4,
      tabooRatio: 0.05,
      characterVoiceDispersion: 0.3,
    },
    categorical: { pov: 'third_limited', tense: 'past', tone: '轻喜剧', register: '口语' },
    dimensions: [
      { key: 'pacing_hooks', value: '章末多为画面或台词，少总结', confidence: 0.9, evidence: [] },
      { key: 'characterization', value: '每人一个缺口与口头禅', confidence: 0.8, evidence: [] },
      { key: 'dialogue', value: '短句、抢话、吐槽', confidence: 0.8, evidence: [] },
      { key: 'humor_tone', value: '朋友式自嘲', confidence: 0.7, evidence: [] },
    ],
    rules: {
      do: [
        { text: '公共事件里写私人反应', confidence: 0.9, tier: 'must' },
        { text: '章末停在画面上', confidence: 0.8, tier: 'must' },
        { text: '对白口语化', confidence: 0.7, tier: 'should' },
      ],
      dont: [{ text: '不要章末总结升华', confidence: 0.9 }],
    },
    lexicon: { preferred: ['摸后颈'], avoid: ['宿命'] },
    sourceEntities: ['周野'],
    anchors: [
      { id: 'a1', profileId: 'p1', kind: 'chapter_end', text: '她袖口的手表带印，一直没退。', charCount: 14, chapterIndex: 65, quality: 1, origin: 'excerpt', createdAt: '' },
      { id: 'a2', profileId: 'p1', kind: 'dialogue', text: '“你刚才……是不是走神了？”', charCount: 14, chapterIndex: 65, quality: 1, origin: 'excerpt', createdAt: '' },
      { id: 'a3', profileId: 'p1', kind: 'action', text: '他把零件盒盖按回去，收据还在手里。', charCount: 17, chapterIndex: 65, quality: 1, origin: 'excerpt', createdAt: '' },
      { id: 'a4', profileId: 'p1', kind: 'description', text: '雨从车棚那头斜过来。', charCount: 10, chapterIndex: 12, quality: 1, origin: 'excerpt', createdAt: '' },
      { id: 'a5', profileId: 'p1', kind: 'interior', text: '糟了糟了，这下糟了。', charCount: 10, chapterIndex: 161, quality: 1, origin: 'excerpt', createdAt: '' },
    ],
    extraRules: [],
    conflicts: [],
    confidence: 0.86,
    mergedFrom: [],
  }
}

describe('planning-style-service · 叙事工程卡', () => {
  it('只提取结构维度、节奏指纹与来源，不把整段画像塞进去', () => {
    const card = renderCraftCard(profile())
    expect(card).toContain('叙事工程')
    expect(card).toContain('章末多为画面或台词')
    expect(card).toContain('章末留钩约 79%')
    expect(card).toContain('参照来源')
    expect(card).not.toContain('朋友式限知视角，短段短句') // summary 不进入工程卡
  })

  it('锚点按章末/对话/动作优先，最多 4 条', () => {
    const anchors = renderAuthorAnchors(profile())
    expect(anchors).toHaveLength(4)
    expect(anchors[0]).toContain('手表带')
    expect(anchors[1]).toContain('是不是走神了')
    expect(anchors[2]).toContain('零件盒')
  })

  it('没有绑定文风库时仍注入现代连载基线', () => {
    const section = planningCraftSection(null)
    expect(section).toContain('五个功能位')
    expect(section).toContain('章末停在画面')
    expect(section).toContain(MODERN_SERIAL_BASELINE.slice(0, 20))
  })

  it('有作者锚点时追加锚点段，并明确禁止复用专有名词', () => {
    const section = planningCraftSection({
      sourceNames: ['示例作品'],
      strength: 60,
      craftCard: renderCraftCard(profile()),
      anchors: renderAuthorAnchors(profile()),
    })
    expect(section).toContain('作者作品的叙事指纹')
    expect(section).toContain('禁止复用其中的人名/地名/专有名词与情节')
    expect(section).toContain('手表带')
  })

  it('作者锚点按阶段挑选类型与数量', () => {
    const ctx = {
      sourceNames: [],
      strength: 60,
      craftCard: '',
      anchors: renderAuthorAnchors(profile(), 5),
    }
    const seed = planningCraftSection(ctx, 'seed')
    expect(seed).toContain('［chapter_end］')
    expect(seed).toContain('［dialogue］')
    expect(seed).not.toContain('［description］')

    const detail = planningCraftSection(ctx, 'chapter-detail')
    expect(detail).toContain('［dialogue］')
    expect(detail).toContain('［interior］')
    expect(detail).not.toContain('［chapter_end］')
  })
})
