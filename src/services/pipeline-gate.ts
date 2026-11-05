import type { QualityGate } from '@shared/types'
import { runQualityGate } from './quality-service'
import { scanForeshadowParity } from './consistency-service'

// 流水线质量门禁：与手动保存钩子共用 runQualityGate（确定性脚本优先，启发式降级），
// 再叠加伏笔对账。此前流水线另有一套同步启发式，会绕过脚本与 findings 透传。
export async function evaluatePipelineGate(text: string): Promise<QualityGate> {
  const quality = await runQualityGate(text)
  const parity = scanForeshadowParity([{ key: '本章', content: text }])
  // 无伏笔标记时对账无信息量，不污染报告
  if (parity.ok && parity.plantedCount === 0 && parity.resolvedCount === 0) return quality
  return {
    ...quality,
    passed: quality.passed && parity.ok,
    deslopTag: quality.deslopTag && parity.ok,
    report: [quality.report, parity.report].filter(Boolean).join('\n'),
  }
}
