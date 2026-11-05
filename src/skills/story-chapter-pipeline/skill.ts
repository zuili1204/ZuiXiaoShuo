import type { Skill } from '@shared/types'

const skill: Skill = {
  id: 'story-chapter-pipeline',
  name: '单章创作流水线',
  description: '按架构卡、正文、连贯性门禁、表达修订、作者审批和追踪写回完成单章，问题稿不自动下传。',
  version: '2.0.0',
  category: 'writing',
  phaseGroup: 'D',
  triggers: ['单章流水线', '章节流水线', '阶段确认', '质量门禁', '可控写作', 'chapter-pipeline'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'architecture', title: '架构卡', instruction: '核对本章承诺、hooks、视角、场景推进、信息差和事实锚点，不写正文；事实冲突时停止。' },
    { id: 'draft', title: '正文', instruction: '依据架构卡和已确认资料写完整正文，覆盖 hooks，让人物行动产生即时结果与章末新状态。' },
    { id: 'continuity', title: '连贯性门禁', instruction: '检查事实、认知、物件、视角、重复和截断；blocking 返回对应阶段修复，不自动下传。' },
    { id: 'polish', title: '表达修订', instruction: '冻结剧情事实，只处理表达与节奏；结构问题退回前序阶段，真实报告质量工具结果。' },
    { id: 'approval', title: '作者审批', instruction: '在关键章节、重大事实变化、未解决 blocking 或作者要求时暂停，展示正文与未解决项。' },
    { id: 'commit', title: '保存与追踪', instruction: '作者确认后写回正文、提交事实增量并按需创建快照；只有工具成功返回后才报告完成。' },
  ],
  references: [],
  scripts: [],
}

export default skill
