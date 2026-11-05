// 规划技能参考文件：统一从主进程技能保险库读取。
// 键名必须与技能的 references 索引、PLAN_STAGE_SKILLS 中的引用完全一致。
import { getSkillFile } from './skill-service'

const PLANNING_REFERENCE_KEYS = [
  'story-plan-workspace/references/plan-brief.md',
  'story-plan-workspace/references/proposal-contracts.md',
  'story-plan-workspace/references/anti-ai-planning.md',
  'story-plan-workspace/references/seed-card.md',
  'story-plan-workspace/references/sample-seed.md',
  'story-plan-workspace/references/volume-budget.md',
  'story-plan-workspace/references/chapter-skeleton.md',
  'story-plan-workspace/references/sample-volume.md',
  'story-plan-workspace/references/sample-chapter.md',
  'story-plan-workspace/references/outline-health.md',
  'story-plan-workspace/references/recalibrate.md',
  'story-idea-incubate/references/idea-cards.md',
  'story-arc-design/references/arc-curves.md',
  'story-pacing/references/pacing-curve.md',
  'story-consistency/references/consistency-rules.md',
  'story-character/references/character-sheet.md',
  'story-outline-optimize/references/optimize-checklist.md',
  'story-worldbuild/references/world-bible.md',
  'story-long-write/references/workflow-setup.md',
  'story-long-write/references/outline-methods.md',
  'story-long-write/references/outline-conflict.md',
  'story-long-write/references/outline-rhythm.md',
  'story-long-write/references/outline-structure-theory.md',
  'story-import/references/structure-mapping-long.md',
  'story-chapter-summary/references/summary-schema.md',
] as const

export const PLANNING_REFERENCE_MAP: Record<string, string> = Object.fromEntries(
  PLANNING_REFERENCE_KEYS.map((key) => [key, getSkillFile(key) ?? '']),
)
