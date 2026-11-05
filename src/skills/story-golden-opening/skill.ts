import type { Skill } from '@shared/types'

// 黄金三章：专为开篇前三章设计强钩子+人设立住+世界观速递
const skill: Skill = {
  id: 'story-golden-opening',
  name: '黄金三章',
  description:
    '黄金三章：专为开篇前三章设计——强钩子抓眼球、主角人设立住、世界观不注水速递、' +
    '并在第三章末抛出第一个大悬念。触发：/golden、/黄金三章、/开篇、「开头怎么写」「前三章」「黄金开头」。',
  version: '1.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['黄金三章', 'golden', '开篇', '前三章', '开头怎么写', '黄金开头', '第一章'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'ch1', title: '第一章·钩子', instruction: '前 300 字内抛出反差/危机，立主角的欲望与处境。' },
    { id: 'ch2', title: '第二章·人设', instruction: '用一次抉择展示主角性格与缺陷，建立读者认同。' },
    { id: 'ch3', title: '第三章·悬念', instruction: '收束小事件并抛出更大悬念，逼读者追读第四章。' },
    { id: 'world', title: '世界观速递', instruction: '只在动作中带出设定，禁止大段说明，控制信息剂量。' },
    { id: 'gate', title: '发布前自检', instruction: '三章自检：钩子够强？人设立住？有无注水？不达标重写。' },
  ],
  references: [
    { path: 'references/golden-opening.md', desc: '黄金三章结构与 10 个开篇钩子范式', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
