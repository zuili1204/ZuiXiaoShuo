import type { Skill } from '@shared/types'

// 封面生成：根据作品设定产出封面提示词（Prompt）与构图建议
const skill: Skill = {
  id: 'story-cover',
  name: '封面生成',
  description:
    '封面生成：根据作品类型/基调/主角与关键场景，产出可用于 AI 绘图的封面提示词（中英文）' +
    '与构图、配色、字体建议。触发：/cover、/封面、/做封面、「书籍封面」「封面提示词」「小说配图」。',
  version: '1.0.0',
  category: 'derivative',
  phaseGroup: 'F',
  triggers: ['封面', 'cover', '做封面', '书籍封面', '封面提示词', '小说配图'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'brief', title: '提炼视觉核心', instruction: '从设定书抽取 1 个最具代表性的视觉母题。' },
    { id: 'prompt', title: '生成提示词', instruction: '产出英文主体提示词+风格词+负向词，并附中文释义。' },
    { id: 'compose', title: '构图建议', instruction: '给出主体位置、景别、视线引导与留白。' },
    { id: 'color', title: '配色与字体', instruction: '给出契合基调的配色与书名字体风格。' },
  ],
  references: [
    { path: 'references/cover-prompts.md', desc: '分题材封面提示词库与构图法则', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
