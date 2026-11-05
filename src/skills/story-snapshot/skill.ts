import type { Skill } from '@shared/types'

const skill: Skill = {
  id: 'story-snapshot',
  name: '章节快照',
  description: '创建、查看、对比和恢复章节快照，保护大幅改写与流水线生成前的原稿；恢复覆盖当前稿前必须确认。',
  version: '2.0.0',
  category: 'tracking',
  phaseGroup: 'D',
  triggers: ['章节快照', '版本历史', '找回旧稿', '恢复版本', '修改前备份', 'snapshot'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'create', title: '创建快照', instruction: '确认作品、章节和完整正文，选择来源；空正文不创建，工具成功后才报告实际版本。' },
    { id: 'compare', title: '查看与对比', instruction: '按时间列出版本，对比事实、结构、人物关系和表达变化，检查伏笔、伤势、认知、物件与章尾状态。' },
    { id: 'restore', title: '确认恢复', instruction: '展示目标版本和当前差异并获得明确确认，先创建恢复前快照，再写回目标正文。' },
    { id: 'sync', title: '恢复后复核', instruction: '刷新摘要、检索和追踪，列出受影响的后续章节；任一步失败都如实报告当前状态。' },
  ],
  references: [],
  scripts: [],
}

export default skill
