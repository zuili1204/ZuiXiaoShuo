import type { Skill } from '@shared/types'

// 弧光设计：为角色/剧情线设计完整的起承转合与情绪曲线
const skill: Skill = {
  id: 'story-arc-design',
  name: '弧光设计',
  description:
    '弧光设计：为关键角色或剧情线设计完整弧光——触发事件、中点反转、至暗时刻、蜕变与回响，' +
    '并画出情绪曲线。触发：/arc、/弧光、/人物弧、「角色成长线」「剧情弧」「情感曲线」。',
  version: '1.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['弧光', 'arc', '人物弧', '剧情弧', '成长线', '情感曲线', '弧线设计'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'trigger', title: '触发事件', instruction: '确定打破角色稳态的事件，弧光由此启动。' },
    { id: 'mid', title: '中点反转', instruction: '设计令角色信念动摇的中点转折，提升张力。' },
    { id: 'dark', title: '至暗时刻', instruction: '安排代价最大的失败，逼出真正的蜕变。' },
    { id: 'echo', title: '回响', instruction: '结尾用镜像场景呼应开头，完成闭环。' },
    { id: 'curve', title: '情绪曲线', instruction: '输出该弧的情绪起伏标注，对齐章节节奏。' },
    { id: 'beat', title: '输出节拍表', instruction: '产出按卷/章序的节拍表文本，由代码写入知识库 arc.md。' },
  ],
  references: [
    { path: 'references/arc-curves.md', desc: '经典弧光类型与情绪曲线模板', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
