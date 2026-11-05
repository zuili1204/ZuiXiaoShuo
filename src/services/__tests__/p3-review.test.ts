import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Chapter } from '@shared/types'
import {
  computeEmotionCurve,
  computeHookStrength,
  computeInfoDensity,
  computePayoffs,
  computeReaderMetrics,
  deterministicQuestions,
  findDropOffs,
} from '@shared/review-metrics'
import {
  runLocalDeterministicChecks,
  scoreDeterministic,
} from '../chapter-eval-service'
import { addChapterFeedback, deleteChapterFeedback, listChapterFeedback } from '../feedback-service'

vi.mock('../ai-outline', () => ({
  getAgent: vi.fn(async () => null),
  callLLM: vi.fn(async () => ''),
  extractJson: vi.fn(() => null),
}))

import { simulateReader } from '../reader-sim-service'

const hookText =
  '林晚停在门外，手还搭在门把上。\n\n' +
  '“你终于来了。”门里传来一个她以为再也听不到的声音。\n\n' +
  '她猛地回头，走廊尽头却空无一人，只有一串湿脚印停在原地。'

const flatText =
  '林晚走进院子，看了一眼槐树。\n\n' +
  '她想起三年前的事，院子还是老样子。\n\n' +
  '她拿起扫帚，把落叶扫到墙角，又放下扫帚。'

const chapter: Chapter = {
  id: 'c1',
  volumeId: 'v1',
  title: '第一章 归来',
  order: 1,
  contentPath: '',
  wordCount: 100,
  status: 'draft',
  targetWordCount: 1000,
  hooks: ['玉佩的来历', '门外是谁'],
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
}

describe('P3 读者模拟确定性指标', () => {
  it('情绪曲线固定五段且数值在 0~100', () => {
    const curve = computeEmotionCurve(hookText)
    expect(curve).toHaveLength(5)
    expect(curve.every((n) => n >= 0 && n <= 100)).toBe(true)
  })

  it('章末有悬念时钩子强度高于平铺收尾', () => {
    const strong = computeHookStrength(hookText)
    const weak = computeHookStrength(flatText)
    expect(strong.chapterEndHook).toBe(true)
    expect(strong.score).toBeGreaterThan(weak.score)
  })

  it('长段无对话会被标为可能的弃读点', () => {
    const long = '他沿着长街一直走，路边的店铺都已经关门，风把招牌吹得作响。'.repeat(20)
    const drops = findDropOffs(long)
    expect(drops.length).toBeGreaterThan(0)
    expect(drops[0].location).toContain('行')
    expect(drops[0].suggestion.length).toBeGreaterThan(0)
  })

  it('信息密度是稳定数值，不会因调用次数漂移', () => {
    const a = computeInfoDensity(hookText)
    const b = computeInfoDensity(hookText)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(100)
  })

  it('细纲期待点按关键词覆盖判为已兑现/未兑现', () => {
    const paid = computePayoffs(hookText, ['门外是谁', '湿脚印'])
    const unpaid = computePayoffs(flatText, ['玉佩'])
    expect(paid.some((p) => p.status !== 'unpaid')).toBe(true)
    expect(unpaid[0].status).toBe('unpaid')
  })

  it('规则版至少给出 3 条可执行建议，并输出模拟问题', () => {
    const metrics = computeReaderMetrics(flatText, chapter.hooks)
    expect(metrics.suggestions.length).toBeGreaterThanOrEqual(3)
    expect(metrics.emotionCurve).toHaveLength(5)
    const questions = deterministicQuestions(chapter.hooks, metrics.chapterEndHook)
    expect(questions.length).toBeGreaterThan(0)
  })

  it('同一章跑两次指标完全一致', () => {
    const a = computeReaderMetrics(hookText, chapter.hooks)
    const b = computeReaderMetrics(hookText, chapter.hooks)
    expect(a).toEqual(b)
  })
})

describe('P3 确定性层补充检查', () => {
  it('引号未闭合判为硬伤', () => {
    const findings = runLocalDeterministicChecks({
      content: '“你终于来了。\n林晚没有回答。',
      targetWordCount: 0,
      hooks: [],
    })
    const quote = findings.find((f) => f.ruleId === 'quote-balance')
    expect(quote?.severity).toBe('blocking')
  })

  it('英文直引号与标点堆叠给出提示', () => {
    const findings = runLocalDeterministicChecks({
      content: '他说："走吧！！"然后转身离开。',
      targetWordCount: 0,
      hooks: [],
    })
    expect(findings.some((f) => f.ruleId === 'straight-quote')).toBe(true)
    expect(findings.some((f) => f.ruleId === 'punctuation-stack')).toBe(true)
  })

  it('同样文本重复三次触发复读提示', () => {
    const sentence = '他站在门外没有说一句话。'
    const findings = runLocalDeterministicChecks({
      content: `${sentence}${sentence}${sentence}`,
      targetWordCount: 0,
      hooks: [],
    })
    expect(findings.some((f) => f.ruleId === 'repetition')).toBe(true)
  })

  it('字数明显不足目标时提示补场景', () => {
    const findings = runLocalDeterministicChecks({
      content: '林晚走进院子。',
      targetWordCount: 1000,
      hooks: [],
    })
    expect(findings.some((f) => f.ruleId === 'word-count')).toBe(true)
  })

  it('同一章确定性检查跑两次结果一致', () => {
    const input = { content: `${hookText}\n\n“你终于来了。`, targetWordCount: 1200, hooks: [] }
    const first = runLocalDeterministicChecks(input)
    const second = runLocalDeterministicChecks(input)
    expect(second).toEqual(first)
    expect(scoreDeterministic(second, 88)).toEqual(scoreDeterministic(first, 88))
  })

  it('评分只对非质量门禁发现额外扣分，避免重复计数', () => {
    const deterministicFinding = (ruleId: string, severity: 'blocking' | 'warning') => ({
      layer: 'deterministic' as const,
      ruleId,
      label: ruleId,
      severity,
      message: ruleId,
    })
    const qualityOnly = scoreDeterministic(
      [deterministicFinding('quality-ai-patterns', 'blocking')],
      90
    )
    const withContinuity = scoreDeterministic(
      [deterministicFinding('continuity-dead-character', 'blocking')],
      90
    )
    expect(qualityOnly.score).toBe(94)
    expect(withContinuity.score).toBeLessThan(qualityOnly.score)
  })
})

describe('P3 读者模拟编排（无模型降级）', () => {
  it('未配置模型时仍返回模拟标识与至少 3 条建议', async () => {
    const result = await simulateReader({
      novelId: 'n1',
      chapter,
      content: flatText,
      profile: { genre: '都市', platform: '番茄', genderOrientation: 'male', note: '' },
      useModel: true,
    })
    expect(result.simulated).toBe(true)
    expect(result.modelAssisted).toBe(false)
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3)
    expect(result.emotionCurve).toHaveLength(5)
    expect(result.notes).toContain('模拟')
  })

  it('包含前文章节时记录章节数', async () => {
    const result = await simulateReader({
      novelId: 'n1',
      chapter: { ...chapter, order: 3 },
      content: hookText,
      previous: [
        { title: '第一章', content: flatText },
        { title: '第二章', content: flatText },
      ],
      profile: { genre: '', platform: '', genderOrientation: 'unspecified', note: '' },
      useModel: false,
    })
    expect(result.chapterCount).toBe(3)
    expect(result.modelAssisted).toBe(false)
  })
})

describe('P3 人工层反馈', () => {
  type Row = Record<string, any>
  let rows: Row[] = []

  beforeEach(() => {
    rows = []
    ;(globalThis as any).window = {
      electronAPI: {
        db: {
          query: vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO chapter_feedback_notes')) {
              const [id, novel_id, chapter_id, eval_run_id, verdict, comment, created_at] = params
              rows.push({ id, novel_id, chapter_id, eval_run_id, verdict, comment, created_at })
              return []
            }
            if (sql.includes('SELECT * FROM chapter_feedback_notes')) {
              return rows
                .filter((r) => r.chapter_id === params[0])
                .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            }
            if (sql.includes('DELETE FROM chapter_feedback_notes')) {
              rows = rows.filter((r) => r.id !== params[0])
              return []
            }
            return []
          }),
        },
      },
    }
  })

  it('接受/拒绝/批注都落库并可列出', async () => {
    await addChapterFeedback({ novelId: 'n1', chapterId: 'c1', verdict: 'accepted', comment: '这版可以' })
    await addChapterFeedback({ novelId: 'n1', chapterId: 'c1', verdict: 'rejected', comment: '节奏拖' })
    await addChapterFeedback({ novelId: 'n1', chapterId: 'c1', verdict: 'note', comment: '补一个反应' })
    const notes = await listChapterFeedback('c1')
    expect(notes).toHaveLength(3)
    expect(notes.map((n) => n.verdict).sort()).toEqual(['accepted', 'note', 'rejected'])
  })

  it('删除只影响指定反馈', async () => {
    const first = await addChapterFeedback({ novelId: 'n1', chapterId: 'c1', verdict: 'note', comment: 'a' })
    await addChapterFeedback({ novelId: 'n1', chapterId: 'c1', verdict: 'note', comment: 'b' })
    await deleteChapterFeedback(first.id)
    const notes = await listChapterFeedback('c1')
    expect(notes).toHaveLength(1)
    expect(notes[0].comment).toBe('b')
  })
})
