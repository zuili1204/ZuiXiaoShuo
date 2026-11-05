import { describe, it, expect } from 'vitest'
import { DISK_SKILLS, getDiskSkill } from '@/skills'
import { SKILL_MD_MAP, matchSkillsByContext } from '../skill-service'

describe('P1 技能注册双点一致性', () => {
  it('每个磁盘技能都有对应的 SKILL.md 注入条目（防静默降级）', () => {
    for (const s of DISK_SKILLS) {
      expect(SKILL_MD_MAP[s.id], `技能 ${s.id} 缺少 ?raw 注入`).toBeTruthy()
      expect(SKILL_MD_MAP[s.id].length).toBeGreaterThan(20)
    }
  })

  it('技能 id 全局唯一', () => {
    const ids = DISK_SKILLS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('六阶段分组完整覆盖 A~F', () => {
    const groups = new Set(DISK_SKILLS.map((s) => s.phaseGroup))
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(groups.has(g as any), `缺少 ${g} 阶段技能`).toBe(true)
    }
  })
})

describe('P1 路由匹配（matchSkillsByContext）', () => {
  // 续写场景优先命中专门技能 story-continue，总路由 story-long-write 同时进入候选
  it('续写意图命中专门的 story-continue', () => {
    const matched = matchSkillsByContext('帮我续写下一章正文，日更节奏')
    expect(matched[0]?.id).toBe('story-continue')
    expect(matched.some((s) => s.id === 'story-long-write')).toBe(true)
  })

  it('一致性意图命中 story-consistency', () => {
    const matched = matchSkillsByContext('这一章人设崩了，前后矛盾，对轨检查一下')
    expect(matched.some((s) => s.id === 'story-consistency')).toBe(true)
  })

  it('点子孵化意图命中 story-idea-incubate', () => {
    const matched = matchSkillsByContext('我有个灵感，帮忙孵化一个点子')
    expect(matched[0]?.id).toBe('story-idea-incubate')
  })

  it('getDiskSkill 能取到既有与新技能', () => {
    expect(getDiskSkill('story-deslop')?.name).toBe('去AI味')
    expect(getDiskSkill('story-adapt')?.name).toBe('改编工坊')
  })
})
