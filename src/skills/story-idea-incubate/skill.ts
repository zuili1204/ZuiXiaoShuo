import type { Skill } from '@shared/types'

// 点子孵化：把一个模糊灵感扩成可落地的故事内核（一句话→种子→钩子）
const skill: Skill = {
  id: 'story-idea-incubate',
  name: '点子孵化',
  description:
    '把一个模糊灵感（一句话/碎片画面）扩成可落地的故事内核：提炼核心冲突、确定类型与情绪基调、' +
    '生成 3 个差异化卖点与 1 个强钩子。触发：/idea、/点子、/孵化、「一个点子」「灵感扩写」「故事内核」「卖点」。',
  version: '1.0.0',
  category: 'ideation',
  phaseGroup: 'A',
  triggers: ['点子', '灵感', '孵化', 'idea', '故事内核', '卖点', '核心冲突', '一句话'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'capture', title: '捕捉原始素材', instruction: '复述用户给的灵感碎片，确认类型/载体（长篇/短篇/短剧）。' },
    { id: 'core', title: '提炼核心冲突', instruction: '用「某人想要X，但Y阻碍，于是Z」句式锁定主冲突，避免主题空泛。' },
    { id: 'hook', title: '设计强钩子', instruction: '给出 1 个开篇反差/悬念钩子，确保前 3 句能抓住读者。' },
    { id: 'sell', title: '生成差异化卖点', instruction: '产出 3 个独特卖点（设定新奇度/情绪价值/爽点机制），避免与同类撞车。' },
    { id: 'decide', title: '输出立项卡片', instruction: '汇总为一页立项卡片：类型、基调、核心冲突、钩子、卖点、目标读者。' },
  ],
  references: [
    { path: 'references/idea-cards.md', desc: '立项卡片模板与 20+ 类型钩子示例', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
