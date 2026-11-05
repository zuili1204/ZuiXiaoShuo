import type { Skill } from '@shared/types'

// 修订：按指定维度（节奏/人设/逻辑/文风）对已有章节做定向改写
const skill: Skill = {
  id: 'story-revision',
  name: '章节修订',
  description:
    '章节修订：按用户指定维度（节奏/人设/逻辑/文风/去AI味）对已有章节做定向改写，' +
    '保留骨架、只改问题处并给出改动说明。触发：/revise、/修订、/改这段、「润改」「重写这章」「调整节奏」。',
  version: '1.0.0',
  category: 'writing',
  phaseGroup: 'D',
  triggers: ['修订', 'revise', '改这段', '润改', '重写这章', '调整节奏', '章节修订'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'scope', title: '界定范围', instruction: '确认修订维度与段落，避免大拆大建。' },
    { id: 'diag', title: '定位问题', instruction: '标出该维度下的具体问题位置（如拖沓句/OOC 对话）。' },
    { id: 'rewrite', title: '定向改写', instruction: '仅改写问题处，保持人设与 voice 一致。' },
    { id: 'note', title: '改动说明', instruction: '输出改动清单与理由，便于作者审阅。' },
  ],
  references: [
    { path: 'references/revision-dimensions.md', desc: '修订维度判定与示例', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
