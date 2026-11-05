import type { Skill, SkillReference } from '@shared/types'
import { DISK_SKILLS } from '@/skills'

// 技能内容统一从主进程保险库读取（打包态为 AES-256-GCM 加密包）。
// IPC 使用同步通道，在模块初始化时注入，避免把 loadSkillForAgent 改成异步。
type SkillFileGlobal = { __ZXS_SKILL_FILES__?: Record<string, string> }

const fileCache = new Map<string, string | null>()

// relKey 形如 "story-long-write/SKILL.md" / "story-plan-workspace/references/plan-brief.md"
export function getSkillFile(relKey: string): string | null {
  const cached = fileCache.get(relKey)
  if (cached !== undefined) return cached

  let content: string | null = null
  if (typeof window !== 'undefined') {
    try {
      content = window.electronAPI?.skills?.readFile(relKey) ?? null
    } catch {
      content = null
    }
  }
  if (content === null) {
    content = (globalThis as SkillFileGlobal).__ZXS_SKILL_FILES__?.[relKey] ?? null
  }
  fileCache.set(relKey, content)
  return content
}

// SKILL.md 内容注册表（导出以便测试与路由层校验双注册点）
export const SKILL_MD_MAP: Record<string, string> = {}
for (const skill of DISK_SKILLS) {
  const md = getSkillFile(`${skill.id}/SKILL.md`)
  if (md) SKILL_MD_MAP[skill.id] = md
}

// 技能注册表：聚合磁盘技能定义（未来可扩展为运行时从用户目录动态加载）
const skillRegistry: Map<string, Skill> = new Map()

DISK_SKILLS.filter((s) => s.enabled).forEach((skill) => {
  skillRegistry.set(skill.id, skill)
})

// 获取所有可用技能（供 UI 展示与选择）
export function getAvailableSkills(): Skill[] {
  return Array.from(skillRegistry.values())
}

// 按 id 获取技能
export function getSkillById(id: string): Skill | undefined {
  return skillRegistry.get(id)
}

// 获取技能的完整 SKILL.md 指令文本
export function getSkillMd(skillId: string): string | null {
  return SKILL_MD_MAP[skillId] ?? null
}

// 根据触发关键词自动匹配适用技能（用于 agent 无显式 skillRefs 时的智能推荐）
// P1 优化：按触发词长度加权（更专有的词权重更高），降低通用词的路由冲突
export function matchSkillsByContext(context: string, limit = 3): Skill[] {
  const lower = context.toLowerCase()
  const scored = Array.from(skillRegistry.values()).map((skill) => {
    const score = skill.triggers.reduce((acc, t) => {
      const tl = t.toLowerCase()
      return acc + (lower.includes(tl) ? 1 + tl.length / 10 : 0)
    }, 0)
    return { skill, score }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.skill)
}

// 为某个 agent 拼装技能指令文本
// skillRefs 形如 ['story-long-write', 'story-long-write/phase4_writing', 'story-deslop']
// 支持整技能引用（注入完整 SKILL.md）或 技能/步骤 精准引用（只注入某一步骤摘要）
export function loadSkillForAgent(skillRefs: string[], context = ''): string {
  if (!skillRefs.length) {
    // 无显式引用时，尝试按上下文智能匹配
    const matched = matchSkillsByContext(context)
    if (!matched.length) return ''
    skillRefs = matched.map((s) => s.id)
  }

  const parts: string[] = ['## 可用技能指令（请严格遵循对应流程）', '']

  for (const ref of skillRefs) {
    const [skillId, section] = ref.split('/')
    const skill = skillRegistry.get(skillId)
    if (!skill) continue

    parts.push(`### 技能：${skill.name}（${skill.id}）`)
    parts.push(skill.description)
    parts.push('')

    if (section) {
      // 精准引用某一步骤：只注入该步骤摘要
      const step = skill.steps.find((s) => s.id === section)
      if (step) {
        parts.push(`**步骤 · ${step.title}**`)
        parts.push(step.instruction)
        parts.push('')
      }
      continue
    }

    // 整技能引用：注入完整 SKILL.md（生产级完整指令）
    const md = SKILL_MD_MAP[skillId]
    if (md) {
      parts.push('#### 完整流程指令（SKILL.md）')
      parts.push(md)
    } else {
      // fallback：仅 steps 摘要
      parts.push('#### 流程摘要（SKILL.md 不可用）')
      skill.steps.forEach((step, idx) => {
        parts.push(`**步骤 ${idx + 1} · ${step.title}**`)
        parts.push(step.instruction)
      })
    }
    parts.push('')
  }

  return parts.join('\n')
}

// 获取单个技能的特定步骤指令
export function getSkillPrompt(skillId: string, section?: string): string | null {
  const skill = skillRegistry.get(skillId)
  if (!skill) return null
  if (!section) {
    return skill.steps.map((s) => `${s.title}：${s.instruction}`).join('\n\n')
  }
  const step = skill.steps.find((s) => s.id === section)
  return step ? step.instruction : null
}

// 获取技能的参考资料索引（供 UI 展示按 Phase 加载）
export function getSkillReferences(skillId: string): SkillReference[] {
  return skillRegistry.get(skillId)?.references ?? []
}

// 按运行时文件读取加载某个 reference 文件内容（用于写作时按需注入权威参考）
// path 形如 "references/workflow-setup.md"，相对于 skill 根
export async function loadSkillReference(
  skillId: string,
  refPath: string
): Promise<string | null> {
  const skill = skillRegistry.get(skillId)
  if (!skill) return null
  // 校验 refPath 在该技能的 references 索引中（防止越权读取任意文件）
  const allowed = skill.references.some((r) => r.path === refPath)
  if (!allowed) return null

  return getSkillFile(`${skillId}/${refPath}`)
}
