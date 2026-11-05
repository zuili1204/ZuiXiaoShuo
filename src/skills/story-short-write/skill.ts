import type { Skill } from '@shared/types'

// 短篇写作：独立完成一篇完整短篇（含闪小说/短篇小说/短剧脚本形态）
const skill: Skill = {
  id: 'story-short-write',
  name: '短篇写作',
  description:
    '短篇写作：从一句话到一篇完整短篇（闪小说/短篇/短剧脚本），强结构、单冲突、重结尾反转。' +
    '触发：/short、/短篇、/写个短篇、「短故事」「微小说」「闪小说」「短剧脚本」。',
  version: '1.0.0',
  category: 'writing',
  phaseGroup: 'D',
  triggers: ['短篇', 'short', '写个短篇', '微小说', '闪小说', '短故事', '短剧脚本'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'core', title: '锁定单冲突', instruction: '短篇只承载一个核心冲突，拒绝多线程。' },
    { id: 'structure', title: '三段式', instruction: '起（立境）→承转（加压）→合（反转/余味）。' },
    { id: 'write', title: '精写', instruction: '每句承重，删冗余，结尾给记忆点。' },
    { id: 'polish', title: '收尾打磨', instruction: '过去AI味，强化结尾的钩子或反转。' },
  ],
  references: [
    { path: 'references/short-forms.md', desc: '短篇/闪小说/短剧结构对照', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
