import { describe, it, expect } from 'vitest'
import { DISK_SKILLS, getDiskSkill } from '@/skills'
import { SKILL_MD_MAP } from '../skill-service'
import { PLANNING_REFERENCE_MAP } from '../planning-skill-bundle'
import {
  PLAN_STAGE_DEEP_SKILLS,
  PLAN_STAGE_SKILLS,
  assertPlanRoutesValid,
  buildPlanningPromptBundle,
  buildPlanningSkillPrompt,
  getPlanningContractText,
  getPlanningReferenceText,
  getPlanningSkillRoutes,
  resolvePlanRoute,
  type PlanStage,
} from '../planning-skill-service'

const CORE_STAGES: PlanStage[] = [
  'seed',
  'master',
  'volume-chapters',
  'chapter-detail',
  'review',
  'calibrate',
  'import-outline',
]

const ALL_STAGES: PlanStage[] = [
  ...CORE_STAGES,
  'seed-assist',
  'characters',
  'worldview',
  'deconstruct',
]

describe('规划技能：注册与路由完整性', () => {
  it('assertPlanRoutesValid 通过（主技能/步骤/参考/契约/版本全部对齐）', () => {
    expect(() => assertPlanRoutesValid()).not.toThrow()
  })

  it('规划技能 story-plan-workspace 已双点注册', () => {
    const skill = getDiskSkill('story-plan-workspace')
    expect(skill?.enabled).toBe(true)
    expect(skill?.version).toBe('2.0.0')
    expect(SKILL_MD_MAP['story-plan-workspace']?.length).toBeGreaterThan(200)
  })

  it('所有启用的磁盘技能都有完整 SKILL.md 映射', () => {
    expect(DISK_SKILLS).toHaveLength(31)
    const missing = DISK_SKILLS.filter((skill) => skill.enabled && !SKILL_MD_MAP[skill.id]).map((skill) => skill.id)
    expect(missing).toEqual([])
  })

  it('十一个规划阶段全部有标准档路由', () => {
    for (const stage of ALL_STAGES) {
      expect(PLAN_STAGE_SKILLS[stage], `缺少阶段路由 ${stage}`).toBeTruthy()
      expect(resolvePlanRoute(stage).stage).toBe(stage)
    }
  })

  it('七个规划步骤在技能索引中真实存在', () => {
    const ids = getDiskSkill('story-plan-workspace')?.steps.map((s) => s.id) ?? []
    expect(ids).toEqual(
      expect.arrayContaining(['a1_seed', 'a1_assist', 'a2_master', 'a3_volume', 'a4_chapter', 'a5_review', 'a6_calibrate'])
    )
  })

  it('标准档不允许自动匹配，避免误命中其他技能', () => {
    for (const route of getPlanningSkillRoutes()) {
      expect(route.allowAutoMatch).toBe(false)
    }
  })

  it('核心阶段的契约统一来自 story-plan-workspace', () => {
    for (const stage of CORE_STAGES) {
      const route = resolvePlanRoute(stage)
      expect(route.contractRefs.length).toBeGreaterThan(0)
      for (const ref of route.contractRefs) {
        expect(ref.startsWith('story-plan-workspace/references/')).toBe(true)
      }
    }
  })

  it('角色/世界观/拆书/单块规划不是规划契约阶段', () => {
    for (const stage of ['characters', 'worldview', 'deconstruct', 'seed-assist'] as PlanStage[]) {
      expect(resolvePlanRoute(stage).contractRefs).toEqual([])
    }
  })

  it('每条路由的参考文件都在技能索引与打包表中声明', () => {
    for (const route of getPlanningSkillRoutes()) {
      for (const ref of [...route.references, ...route.contractRefs]) {
        expect(PLANNING_REFERENCE_MAP[ref], `未打包 ${ref}`).toBeTruthy()
        const marker = '/references/'
        const skillId = ref.slice(0, ref.indexOf(marker))
        const refPath = ref.slice(ref.indexOf(marker) + 1)
        expect(
          getDiskSkill(skillId)?.references.some((r) => r.path === refPath),
          `技能索引未声明 ${ref}`
        ).toBe(true)
      }
    }
  })

  it('立项参考不再教人物档案体字段', () => {
    const seedCard = getPlanningReferenceText('story-plan-workspace', 'references/seed-card.md')
    expect(seedCard).toBeTruthy()
    const template = seedCard!.slice(0, seedCard!.indexOf('## 坏 / 好对比'))
    expect(template).not.toMatch(/欲望\s*\/\s*阻碍/)
    expect(template).not.toMatch(/功能\s*\/\s*缺口/)
    expect(template).toContain('第一次出场')
  })

  it('每个核心阶段都注入反模板准则', () => {
    for (const stage of CORE_STAGES) {
      expect(resolvePlanRoute(stage).references).toContain(
        'story-plan-workspace/references/anti-ai-planning.md'
      )
    }
  })

  it('反模板准则包含决策密度与事实口径', () => {
    const text = getPlanningReferenceText('story-plan-workspace', 'references/anti-ai-planning.md')
    expect(text).toContain('决策密度')
    expect(text).toContain('会改变关系、信息或局面的选择')
    expect(text).toContain('评分口径')
  })

  it('规划样本按输出类型分阶段注入', () => {
    const refs = (stage: PlanStage) => resolvePlanRoute(stage).references
    expect(refs('seed')).toContain('story-plan-workspace/references/sample-seed.md')
    expect(refs('seed')).not.toContain('story-plan-workspace/references/sample-volume.md')
    expect(refs('volume-chapters')).toContain('story-plan-workspace/references/sample-volume.md')
    expect(refs('volume-chapters')).not.toContain('story-plan-workspace/references/sample-chapter.md')
    expect(refs('chapter-detail')).toContain('story-plan-workspace/references/sample-chapter.md')
    expect(refs('chapter-detail')).not.toContain('story-plan-workspace/references/sample-volume.md')
  })

  it('技能引用指向真实技能与步骤', () => {
    for (const route of getPlanningSkillRoutes()) {
      for (const ref of route.skillRefs) {
        const [skillId, stepId] = ref.split('/')
        const skill = getDiskSkill(skillId)
        expect(skill, `未注册技能 ${skillId}`).toBeTruthy()
        if (stepId) {
          expect(skill?.steps.some((s) => s.id === stepId), `缺少步骤 ${ref}`).toBe(true)
        }
      }
      for (const support of route.supportSkills) {
        expect(getDiskSkill(support.split('/')[0]), `辅助技能未注册 ${support}`).toBeTruthy()
      }
    }
  })
})

describe('规划技能：深度档与方法论解耦', () => {
  it('只有 master / volume-chapters 支持深度档', () => {
    expect(Object.keys(PLAN_STAGE_DEEP_SKILLS).sort()).toEqual(['master', 'volume-chapters'])
  })

  it('深度档改挂 story-long-write/phase3_outline，但契约仍是规划技能', () => {
    for (const stage of ['master', 'volume-chapters'] as PlanStage[]) {
      const route = resolvePlanRoute(stage, 'deep')
      expect(route.primarySkill).toBe('story-long-write/phase3_outline')
      expect(route.quality).toBe('deep')
      expect(route.contractRefs).toEqual(['story-plan-workspace/references/proposal-contracts.md'])
      expect(route.references.some((r) => r.startsWith('story-long-write/references/'))).toBe(true)
    }
  })

  it('未开放深度档的阶段明确报错而不是静默回退', () => {
    for (const stage of ['seed', 'review', 'import-outline'] as PlanStage[]) {
      expect(() => resolvePlanRoute(stage, 'deep')).toThrow(/不支持深度档/)
    }
  })

  it('未知阶段与非法档位都会抛错', () => {
    expect(() => resolvePlanRoute('nope' as PlanStage)).toThrow(/未知规划阶段/)
    expect(() => resolvePlanRoute('seed', 'ultra' as never)).toThrow(/未知规划档位/)
  })
})

describe('规划技能：Prompt 拼装', () => {
  it('标准档 prompt 同时包含步骤指令、方法论参考与输出契约', () => {
    const prompt = buildPlanningSkillPrompt('seed')
    expect(prompt).toContain('A1 · 立项书')
    expect(prompt).toContain('参考文件：story-plan-workspace/references/seed-card.md')
    expect(prompt).toContain('契约参考：story-plan-workspace/references/proposal-contracts.md')
  })

  it('每个核心阶段都能拼出非空 prompt', () => {
    for (const stage of CORE_STAGES) {
      expect(buildPlanningSkillPrompt(stage).length).toBeGreaterThan(500)
      expect(getPlanningContractText(stage)).toContain('proposal-contracts.md')
    }
  })

  it('bundle 保留任务指令与输出契约原样', () => {
    const bundle = buildPlanningPromptBundle('master', 'standard', 'TASK-X', 'CONTRACT-Y')
    expect(bundle.taskPrompt).toBe('TASK-X')
    expect(bundle.outputContract).toBe('CONTRACT-Y')
    expect(bundle.skillPrompt).toContain('A2 · 主线与分卷')
    expect(bundle.skillPrompt).not.toContain('参考文件：')
    expect(bundle.referenceText).toContain('story-plan-workspace/references/volume-budget.md')
    expect(bundle.contractText).toContain('proposal-contracts.md')
  })

  it('超长参考按上限截断并标注原文长度', () => {
    const text = getPlanningReferenceText('story-plan-workspace', 'references/proposal-contracts.md')
    expect(text).toBeTruthy()
    expect(text!.length).toBeLessThanOrEqual(4200)
  })

  it('不存在的参考返回 null', () => {
    expect(getPlanningReferenceText('story-plan-workspace', 'references/missing.md')).toBeNull()
  })
})
