import type { Skill } from '@shared/types'

// 立项设定：把孵化出的点子落成结构化的《作品设定书》（对标 oh-story story-setup）
const skill: Skill = {
  id: 'story-setup',
  name: '立项设定',
  description:
    '立项设定：把点子落成结构化《作品设定书》——一句话简介、世界观锚点、主角人设、核心爽点链、' +
    '卷级目标与预期篇幅。触发：/setup、/立项、/设定书、「开书」「大纲前」「建立设定」「作品档案」。',
  version: '1.0.0',
  category: 'ideation',
  phaseGroup: 'A',
  triggers: ['立项', '设定书', 'setup', '开书', '作品档案', '作品设定', '建立设定'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'pitch', title: '一句话简介', instruction: '用「类型+主角+核心冲突+独特卖点」写出可上架的简介。' },
    { id: 'world', title: '世界观锚点', instruction: '仅列驱动剧情的 3-5 条铁律（力量体系/禁忌/时代背景），不过度展开。' },
    { id: 'hero', title: '主角人设', instruction: '给出主角欲望、缺陷、成长线起点，确保与核心冲突咬合。' },
    { id: 'loop', title: '爽点链', instruction: '设计可复用的爽点机制（打脸/升级/收货），保证日更可持续。' },
    { id: 'plan', title: '卷级规划', instruction: '给出卷数、每卷目标与总篇幅预估，作为后续大纲的输入。' },
  ],
  references: [
    { path: 'references/setup-template.md', desc: '作品设定书模板（可直接填充）', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
