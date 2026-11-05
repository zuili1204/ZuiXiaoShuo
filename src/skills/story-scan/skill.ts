import type { Skill } from '@shared/types'

// 题材扫描：结合市场与平台调性，评估点子的赛道热度与差异化空间
const skill: Skill = {
  id: 'story-scan',
  name: '题材扫描',
  description:
    '题材扫描与赛道评估：分析目标平台的类型热度、竞品雷区与差异化空间，给出「红海/蓝海」判定与切入点建议。' +
    '触发：/scan、/扫描、/题材、「市场分析」「赛道」「竞品」「蓝海」「题材热度」。',
  version: '1.0.0',
  category: 'ideation',
  phaseGroup: 'A',
  triggers: ['题材', '扫描', 'scan', '赛道', '竞品', '蓝海', '红海', '市场分析', '热度'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'classify', title: '归类题材', instruction: '将用户点子归入二级题材（如：玄幻-废柴流、都市-神医），明确对标赛道。' },
    { id: 'heat', title: '评估热度', instruction: '从更新量/读者基数/完本率三维度判断红海程度，标注饱和信号。' },
    { id: 'gap', title: '找差异化', instruction: '列出 3 个竞品雷区（套路重复/爽点疲软），给出可切入的空白带。' },
    { id: 'report', title: '输出扫描报告', instruction: '给出赛道判定、推荐切入点、风险与预期受众规模。' },
  ],
  references: [
    { path: 'references/genre-map.md', desc: '主流题材赛道地图与热度信号', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
