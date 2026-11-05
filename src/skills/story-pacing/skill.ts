import type { Skill } from '@shared/types'

// 节奏审查：评估章节/卷的情绪曲线，定位拖沓与断档
const skill: Skill = {
  id: 'story-pacing',
  name: '节奏审查',
  description:
    '节奏审查：评估章节/卷的情绪曲线密度，定位连续无波动的拖沓段、过早高潮与断档，' +
    '给出重排与爽点补强方案。触发：/pacing、/节奏、/节奏感、「节奏太慢」「拖沓」「高潮来得太早」。',
  version: '2.0.0',
  category: 'review',
  phaseGroup: 'E',
  triggers: ['节奏', 'pacing', '节奏感', '拖沓', '节奏太慢', '高潮太早', '节奏审查'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'curve', title: '绘制双曲线', instruction: '分别标注事件压力与情绪强度，记录每章任务、信息、决定、关系和期待的实际增量。' },
    { id: 'drag', title: '定位重复与断档', instruction: '找出无新增功能的重复段、铺垫不足的高潮和后果缺失；低压章有功能时不判水。' },
    { id: 'peak', title: '检查兑现与恢复', instruction: '核对高潮与铺垫是否匹配，强情绪后是否保留必要后果和过渡，避免持续峰值造成疲劳。' },
    { id: 'fix', title: '只读建议', instruction: '按根因给出删减、补拍、重排或期待补强建议；实际改写交给 story-revision 或 story-outline-optimize。' },
  ],
  references: [
    { path: 'references/pacing-curve.md', desc: '情绪曲线模型与节奏诊断表', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
