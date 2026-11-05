import { getDiskSkill } from '@/skills'
import { getSkillMd, loadSkillForAgent } from './skill-service'
import { PLANNING_REFERENCE_MAP } from './planning-skill-bundle'

export type PlanStage =
  | 'seed'
  | 'seed-assist'
  | 'master'
  | 'volume-chapters'
  | 'chapter-detail'
  | 'review'
  | 'calibrate'
  | 'import-outline'
  | 'characters'
  | 'worldview'
  | 'deconstruct'

export type PlanQuality = 'standard' | 'deep'

export interface PlanSkillRoute {
  stage: PlanStage
  primarySkill: string
  supportSkills: string[]
  skillRefs: string[]
  references: string[]
  contractRefs: string[]
  outputSchema: string
  quality: PlanQuality
  pinnedVersion?: string
  allowAutoMatch: false
}

export interface PlanningPromptBundle {
  skillPrompt: string
  referenceText: string
  contractText: string
  taskPrompt: string
  outputContract: string
}

export interface PlanningPromptOptions {
  /** 评估实验用：覆盖路由声明的参考列表，缺省时使用路由原值 */
  references?: string[]
}

const WORKSPACE = 'story-plan-workspace'
const CONTRACT = `${WORKSPACE}/references/proposal-contracts.md`

function route(
  stage: PlanStage,
  primarySkill: string,
  supportSkills: string[],
  skillRefs: string[],
  references: string[],
  outputSchema: string,
  quality: PlanQuality = 'standard',
  pinnedVersion?: string
): PlanSkillRoute {
  return {
    stage,
    primarySkill,
    supportSkills,
    skillRefs,
    references,
    contractRefs: quality === 'deep' || stage === 'characters' || stage === 'worldview' || stage === 'deconstruct' || stage === 'seed-assist'
      ? quality === 'deep'
        ? [CONTRACT]
        : []
      : [CONTRACT],
    outputSchema,
    quality,
    pinnedVersion,
    allowAutoMatch: false,
  }
}

const WORKSPACE_VERSION = '2.0.0'

export const PLAN_STAGE_SKILLS: Record<PlanStage, PlanSkillRoute> = {
  seed: route(
    'seed',
    `${WORKSPACE}/a1_seed`,
    ['story-idea-incubate'],
    [`${WORKSPACE}/a1_seed`, 'story-idea-incubate/core'],
    [`${WORKSPACE}/references/anti-ai-planning.md`, `${WORKSPACE}/references/seed-card.md`, `${WORKSPACE}/references/sample-seed.md`, `${WORKSPACE}/references/plan-brief.md`],
    'SeedProposal',
    'standard',
    WORKSPACE_VERSION
  ),
  'seed-assist': route(
    'seed-assist',
    `${WORKSPACE}/a1_assist`,
    ['story-idea-incubate'],
    [`${WORKSPACE}/a1_assist`, 'story-idea-incubate/core'],
    [`${WORKSPACE}/references/anti-ai-planning.md`, `${WORKSPACE}/references/seed-card.md`, `${WORKSPACE}/references/sample-seed.md`, `${WORKSPACE}/references/plan-brief.md`],
    'SeedAssist',
    'standard',
    WORKSPACE_VERSION
  ),
  master: route(
    'master',
    `${WORKSPACE}/a2_master`,
    ['story-arc-design'],
    [`${WORKSPACE}/a2_master`, 'story-arc-design/curve'],
    [`${WORKSPACE}/references/anti-ai-planning.md`, `${WORKSPACE}/references/volume-budget.md`, 'story-arc-design/references/arc-curves.md'],
    'MasterPlanProposal',
    'standard',
    WORKSPACE_VERSION
  ),
  'volume-chapters': route(
    'volume-chapters',
    `${WORKSPACE}/a3_volume`,
    ['story-pacing'],
    [`${WORKSPACE}/a3_volume`, 'story-pacing/curve'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      `${WORKSPACE}/references/chapter-skeleton.md`,
      `${WORKSPACE}/references/volume-budget.md`,
      `${WORKSPACE}/references/sample-volume.md`,
      'story-pacing/references/pacing-curve.md',
    ],
    'VolumeChaptersProposal',
    'standard',
    WORKSPACE_VERSION
  ),
  'chapter-detail': route(
    'chapter-detail',
    `${WORKSPACE}/a4_chapter`,
    ['story-character'],
    [`${WORKSPACE}/a4_chapter`, 'story-character/desire'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      `${WORKSPACE}/references/chapter-skeleton.md`,
      `${WORKSPACE}/references/sample-chapter.md`,
      'story-character/references/character-sheet.md',
    ],
    'ChapterDetailProposal',
    'standard',
    WORKSPACE_VERSION
  ),
  review: route(
    'review',
    `${WORKSPACE}/a5_review`,
    ['story-outline-optimize', 'story-consistency'],
    [`${WORKSPACE}/a5_review`, 'story-outline-optimize/diag', 'story-consistency/fore'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      `${WORKSPACE}/references/outline-health.md`,
      'story-outline-optimize/references/optimize-checklist.md',
      'story-consistency/references/consistency-rules.md',
    ],
    'OutlineReview',
    'standard',
    WORKSPACE_VERSION
  ),
  calibrate: route(
    'calibrate',
    `${WORKSPACE}/a6_calibrate`,
    ['story-consistency', 'story-character'],
    [`${WORKSPACE}/a6_calibrate`, 'story-consistency/fact', 'story-character/arc'],
    [`${WORKSPACE}/references/anti-ai-planning.md`, `${WORKSPACE}/references/recalibrate.md`, 'story-consistency/references/consistency-rules.md'],
    'RecalibrateDiff',
    'standard',
    WORKSPACE_VERSION
  ),
  'import-outline': route(
    'import-outline',
    'story-long-write/phase3_outline',
    ['story-import', 'story-chapter-summary'],
    ['story-long-write/phase3_outline', 'story-import/phase3_migrate', 'story-chapter-summary/json'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      'story-long-write/references/workflow-setup.md',
      'story-long-write/references/outline-methods.md',
      'story-import/references/structure-mapping-long.md',
    ],
    'OutlineDocument',
    'deep'
  ),
  characters: route(
    'characters',
    'story-character',
    ['story-arc-design'],
    ['story-character', 'story-arc-design/curve'],
    ['story-character/references/character-sheet.md', 'story-arc-design/references/arc-curves.md'],
    'CharacterProposal'
  ),
  worldview: route(
    'worldview',
    'story-worldbuild',
    [],
    ['story-worldbuild'],
    ['story-worldbuild/references/world-bible.md'],
    'WorldviewProposal'
  ),
  deconstruct: route(
    'deconstruct',
    'story-deconstruct',
    [],
    ['story-deconstruct'],
    [],
    'NovelTemplate'
  ),
}

export const PLAN_STAGE_DEEP_SKILLS: Partial<Record<PlanStage, PlanSkillRoute>> = {
  master: route(
    'master',
    'story-long-write/phase3_outline',
    ['story-arc-design'],
    ['story-long-write/phase3_outline', 'story-arc-design/curve'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      'story-long-write/references/workflow-setup.md',
      'story-long-write/references/outline-methods.md',
      'story-long-write/references/outline-conflict.md',
      'story-arc-design/references/arc-curves.md',
    ],
    'MasterPlanProposal',
    'deep'
  ),
  'volume-chapters': route(
    'volume-chapters',
    'story-long-write/phase3_outline',
    ['story-pacing'],
    ['story-long-write/phase3_outline', 'story-pacing/curve'],
    [
      `${WORKSPACE}/references/anti-ai-planning.md`,
      'story-long-write/references/workflow-setup.md',
      'story-long-write/references/outline-rhythm.md',
      'story-long-write/references/outline-structure-theory.md',
      `${WORKSPACE}/references/sample-volume.md`,
      'story-pacing/references/pacing-curve.md',
    ],
    'VolumeChaptersProposal',
    'deep'
  ),
}

const CORE_STAGES: PlanStage[] = [
  'seed',
  'master',
  'volume-chapters',
  'chapter-detail',
  'review',
  'calibrate',
  'import-outline',
]

export const MAX_REFERENCE_CHARS = 4000
/** 单次规划注入的参考总量上限；契约文本单独拼接，不会挤掉 */
export const MAX_TOTAL_REFERENCE_CHARS = 16000

export function resolvePlanRoute(stage: PlanStage, quality: PlanQuality = 'standard'): PlanSkillRoute {
  if (quality !== 'standard' && quality !== 'deep') {
    throw new Error(`未知规划档位：${quality}`)
  }
  if (quality === 'deep') {
    const deep = PLAN_STAGE_DEEP_SKILLS[stage]
    if (!deep) throw new Error(`阶段 ${stage} 不支持深度档`)
    return deep
  }
  const base = PLAN_STAGE_SKILLS[stage]
  if (!base) throw new Error(`未知规划阶段：${stage}`)
  return base
}

function splitReference(ref: string): { skillId: string; refPath: string } {
  const marker = '/references/'
  const idx = ref.indexOf(marker)
  if (idx <= 0) throw new Error(`参考文件格式非法：${ref}`)
  return { skillId: ref.slice(0, idx), refPath: ref.slice(idx + 1) }
}

function splitSkillRef(ref: string): { skillId: string; stepId?: string } {
  const [skillId, stepId] = ref.split('/')
  if (!skillId) throw new Error(`技能引用格式非法：${ref}`)
  return { skillId, stepId }
}

export function getPlanningReferenceText(skillId: string, refPath: string): string | null {
  const key = `${skillId}/${refPath}`
  const text = PLANNING_REFERENCE_MAP[key]
  if (!text) return null
  if (text.length <= MAX_REFERENCE_CHARS) return text
  return `${text.slice(0, MAX_REFERENCE_CHARS)}\n\n…（参考文件已截断，原文 ${text.length} 字符）`
}

export function getPlanningContractText(stage: PlanStage, quality: PlanQuality = 'standard'): string {
  const selected = resolvePlanRoute(stage, quality)
  if (!selected.contractRefs.length) return ''
  return selected.contractRefs
    .map((ref) => {
      const { skillId, refPath } = splitReference(ref)
      const text = getPlanningReferenceText(skillId, refPath)
      if (!text) throw new Error(`规划契约缺失：${ref}`)
      return `## 契约参考：${ref}\n${text}`
    })
    .join('\n\n')
}

/** 按路由顺序拼接参考；超出总量预算时宁可少注入靠后的样本，也不截断靠前的规则 */
export function buildReferenceBlocks(refs: string[]): string {
  const parts: string[] = []
  const skipped: string[] = []
  let used = 0
  for (const ref of refs) {
    const { skillId, refPath } = splitReference(ref)
    const text = getPlanningReferenceText(skillId, refPath)
    if (!text) throw new Error(`规划参考缺失：${ref}`)
    const block = `## 参考文件：${ref}\n${text}`
    if (used > 0 && used + block.length > MAX_TOTAL_REFERENCE_CHARS) {
      skipped.push(ref)
      continue
    }
    parts.push(block)
    used += block.length
  }
  if (skipped.length) {
    parts.push(
      `## 参考注入预算\n为控制篇幅，以下参考本次未注入（上限 ${MAX_TOTAL_REFERENCE_CHARS} 字符）：\n${skipped
        .map((ref) => `- ${ref}`)
        .join('\n')}`
    )
  }
  return parts.join('\n\n')
}

export function buildPlanningSkillPrompt(
  stage: PlanStage,
  quality: PlanQuality = 'standard',
  options: PlanningPromptOptions = {}
): string {
  const selected = resolvePlanRoute(stage, quality)
  const skillPrompt = loadSkillForAgent(selected.skillRefs, '')
  if (!skillPrompt.trim()) {
    throw new Error(`规划技能未注册或步骤为空：${selected.primarySkill}`)
  }

  return [
    skillPrompt,
    buildReferenceBlocks(options.references ?? selected.references),
    getPlanningContractText(stage, quality),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function buildPlanningPromptBundle(
  stage: PlanStage,
  quality: PlanQuality,
  taskPrompt: string,
  outputContract: string,
  options: PlanningPromptOptions = {}
): PlanningPromptBundle {
  const selected = resolvePlanRoute(stage, quality)
  const skillPrompt = loadSkillForAgent(selected.skillRefs, '')
  if (!skillPrompt.trim()) {
    throw new Error(`规划技能未注册或步骤为空：${selected.primarySkill}`)
  }

  return {
    skillPrompt,
    referenceText: buildReferenceBlocks(options.references ?? selected.references),
    contractText: getPlanningContractText(stage, quality),
    taskPrompt,
    outputContract,
  }
}

function validateRoute(selected: PlanSkillRoute, label: string, errors: string[]): void {
  const primary = splitSkillRef(selected.primarySkill)
  const primarySkill = getDiskSkill(primary.skillId)
  if (!primarySkill) {
    errors.push(`${label}: 主技能未注册 ${primary.skillId}`)
  } else {
    if (!primarySkill.enabled) errors.push(`${label}: 主技能未启用 ${primary.skillId}`)
    if (primary.stepId && !primarySkill.steps.some((s) => s.id === primary.stepId)) {
      errors.push(`${label}: 主技能缺少步骤 ${selected.primarySkill}`)
    }
  }

  for (const ref of selected.skillRefs) {
    const { skillId, stepId } = splitSkillRef(ref)
    const skill = getDiskSkill(skillId)
    if (!skill) {
      errors.push(`${label}: skillRef 指向未注册技能 ${ref}`)
      continue
    }
    if (stepId && !skill.steps.some((s) => s.id === stepId)) {
      errors.push(`${label}: skillRef 指向不存在的步骤 ${ref}`)
    }
  }

  for (const support of selected.supportSkills) {
    const supportRef = splitSkillRef(support)
    if (!getDiskSkill(supportRef.skillId)) {
      errors.push(`${label}: 辅助技能未注册 ${support}`)
    }
  }

  if (selected.pinnedVersion && primarySkill && primarySkill.version !== selected.pinnedVersion) {
    errors.push(`${label}: 版本锁定不一致，期望 ${selected.pinnedVersion}，实际 ${primarySkill.version}`)
  }

  const validateReferenceList = (refs: string[], field: string) => {
    for (const ref of refs) {
      let parsed: { skillId: string; refPath: string }
      try {
        parsed = splitReference(ref)
      } catch (err) {
        errors.push(`${label}: ${field} 格式非法 ${ref}`)
        continue
      }
      const owner = getDiskSkill(parsed.skillId)
      if (!owner) {
        errors.push(`${label}: ${field} 指向未注册技能 ${ref}`)
        continue
      }
      if (!owner.references.some((r) => r.path === parsed.refPath)) {
        errors.push(`${label}: ${field} 未在技能索引中声明 ${ref}`)
      }
      const text = PLANNING_REFERENCE_MAP[ref]
      if (!text || !text.trim()) {
        errors.push(`${label}: ${field} 未打包或内容为空 ${ref}`)
      }
    }
  }
  validateReferenceList(selected.references, 'references')
  validateReferenceList(selected.contractRefs, 'contractRefs')

  if (CORE_STAGES.includes(selected.stage)) {
    if (!selected.references.length) errors.push(`${label}: 核心阶段必须有方法论参考`)
    if (!selected.contractRefs.length) errors.push(`${label}: 核心阶段必须有契约参考`)
    if (!selected.contractRefs.every((ref) => ref.startsWith(`${WORKSPACE}/references/`))) {
      errors.push(`${label}: 契约参考必须来自 ${WORKSPACE}`)
    }
  }

  if (!selected.outputSchema.trim()) errors.push(`${label}: outputSchema 为空`)
}

export function assertPlanRoutesValid(): void {
  const errors: string[] = []
  const workspace = getDiskSkill(WORKSPACE)
  if (!workspace) {
    throw new Error(`规划技能未注册：${WORKSPACE}`)
  }
  if (!getSkillMd(WORKSPACE)?.trim()) {
    errors.push(`${WORKSPACE}: SKILL.md 未注入`)
  }
  const requiredSteps = ['a1_seed', 'a2_master', 'a3_volume', 'a4_chapter', 'a5_review', 'a6_calibrate']
  for (const step of requiredSteps) {
    if (!workspace.steps.some((s) => s.id === step)) {
      errors.push(`${WORKSPACE}: 缺少步骤 ${step}`)
    }
  }

  const labels = new Set<string>()
  const allRoutes: Array<{ label: string; route: PlanSkillRoute }> = [
    ...Object.entries(PLAN_STAGE_SKILLS).map(([stage, r]) => ({ label: `standard:${stage}`, route: r })),
    ...Object.entries(PLAN_STAGE_DEEP_SKILLS).map(([stage, r]) => ({ label: `deep:${stage}`, route: r as PlanSkillRoute })),
  ]
  for (const { label, route: selected } of allRoutes) {
    const key = `${label}:${selected.primarySkill}`
    if (labels.has(key)) continue
    labels.add(key)
    validateRoute(selected, label, errors)
  }

  for (const [key, text] of Object.entries(PLANNING_REFERENCE_MAP)) {
    if (!text || !text.trim()) errors.push(`参考包为空：${key}`)
    try {
      splitReference(key)
    } catch {
      errors.push(`参考包键名非法：${key}`)
    }
  }

  if (errors.length) {
    throw new Error(`规划技能路由校验失败：\n- ${errors.join('\n- ')}`)
  }
}

export function getPlanningSkillRoutes(): PlanSkillRoute[] {
  return [
    ...Object.values(PLAN_STAGE_SKILLS),
    ...Object.values(PLAN_STAGE_DEEP_SKILLS).filter((r): r is PlanSkillRoute => !!r),
  ]
}
