import type { Skill } from '@shared/types'

// 一致性审查：跨章核查事实/时间线/人设/伏笔，输出冲突清单
const skill: Skill = {
  id: 'story-consistency',
  name: '一致性审查',
  description:
    '一致性审查：跨章核查事实冲突、时间线错乱、人设崩塌(OOC)、伏笔未回收/错回收，' +
    '输出带章节定位的冲突清单与修复建议。触发：/consistency、/一致性、/对轨、「人设崩了」「时间线乱」「前后矛盾」。',
  version: '1.0.0',
  category: 'review',
  phaseGroup: 'E',
  triggers: ['一致性', 'consistency', '对轨', '人设崩', '时间线乱', '前后矛盾', '事实冲突'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'fact', title: '事实核对', instruction: '比对人物姓名/年龄/身份/地点在各章是否一致。' },
    { id: 'time', title: '时间线', instruction: '排布事件时序，找出穿越/重叠/空白。' },
    { id: 'ooc', title: '人设(OOC)', instruction: '标记与人物卡性格/动机相悖的言行。' },
    { id: 'fore', title: '伏笔对账', instruction: '对照伏笔埋设与回收，列出悬空与错配。' },
    { id: 'report', title: '输出清单', instruction: '给出 [章节:问题:建议] 清单，按严重度排序。' },
  ],
  references: [
    { path: 'references/consistency-rules.md', desc: '一致性审查规则与严重度分级', phase: '1-5' },
  ],
  scripts: [
    { path: 'scripts/check-foreshadow-parity.js', command: 'node scripts/check-foreshadow-parity.js {file}', desc: '伏笔埋设/回收对账（确定性校验）' },
  ],
}

export default skill
