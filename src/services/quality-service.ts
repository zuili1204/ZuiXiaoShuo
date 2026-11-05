import type { QualityGate } from '@shared/types'

// P0：质量门禁服务
// 集成 story-deslop 的确定性脚本（check-ai-patterns / check-degeneration / normalize-punctuation）
// 作为写作保存钩子与 CI 的调用入口。无脚本环境（如测试/浏览器）降级为启发式评分。

// 启发式 AI 句式 / 退化检测（与 story-deslop 的 banned-words 思路一致）
const AI_PATTERNS = [
  /首先，?.*?其次，?.*?最后，?/g,
  /总体而言/g, /值得注意的是/g, /综上所述/g,
  /在这个.*?的过程中/g, /不仅.*?更.*?/g,
  /毫无疑问/g, /显而易见/g, /此刻，?/g, /仿佛.*?一般/g,
]
const DEGENERATION_PATTERNS = [
  /(\S{8,})\1/g, /[\.\!\?]{3,}/g, /——{2,}/g,
]

export function estimateQualityGate(text: string): QualityGate {
  const checkedAt = new Date().toISOString()
  if (!text || text.length < 50) {
    return { score: 0, passed: false, deslopTag: false, aiPatternHits: 0, degenerationHits: 0, checkedAt }
  }
  const aiPatternHits = AI_PATTERNS.reduce((acc, p) => acc + (text.match(p)?.length || 0), 0)
  const degenerationHits = DEGENERATION_PATTERNS.reduce((acc, p) => acc + (text.match(p)?.length || 0), 0)
  const lengthBonus = Math.min(20, Math.floor(text.length / 500))
  const penalty = aiPatternHits * 6 + degenerationHits * 4
  const score = Math.max(0, Math.min(100, 70 + lengthBonus - penalty))
  const passed = score >= 60 && aiPatternHits <= 2
  return {
    score,
    passed,
    deslopTag: aiPatternHits <= 1,
    aiPatternHits,
    degenerationHits,
    report: `启发式评分：AI句式命中 ${aiPatternHits}，退化命中 ${degenerationHits}，综合分 ${score}${passed ? '（通过）' : '（未通过，建议去AI味）'}`,
    checkedAt,
  }
}

// 运行 deslop 确定性脚本（需 electron 主进程提供 runScript 能力）
// 返回脚本合并后的质量门禁结果；若主进程不可用则降级为启发式。
export async function runQualityGate(text: string): Promise<QualityGate> {
  try {
    const api = (window as any).electronAPI
    if (api?.quality?.check) {
      const res = await api.quality.check(text)
      if (res && typeof res.score === 'number') {
        return {
          score: res.score,
          passed: res.passed,
          deslopTag: res.deslopTag ?? res.passed,
          aiPatternHits: res.aiPatternHits ?? 0,
          degenerationHits: res.degenerationHits ?? 0,
          report: res.report,
          checkedAt: new Date().toISOString(),
          findings: Array.isArray(res.findings) ? res.findings : undefined,
        }
      }
    }
  } catch (e) {
    console.error('quality script failed, fallback to heuristic:', e)
  }
  return estimateQualityGate(text)
}

// 质量门禁是否通过（供保存钩子直接判定）
export async function isQualityPassed(text: string): Promise<boolean> {
  const g = await runQualityGate(text)
  return g.passed
}
