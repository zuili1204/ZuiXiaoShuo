import type { Skill } from '@shared/types'

// 续写：基于上一章结尾与大纲，生成下一章正文（日更核心）
const skill: Skill = {
  id: 'story-continue',
  name: '续写',
  description:
    '续写：基于上一章结尾、章节大纲与角色状态，生成下一章正文，自动保持人设/视角/伏笔连续。' +
    '触发：/continue、/续写、/接着写、「继续写」「下一章」「日更」「接上文」。',
  version: '1.0.0',
  category: 'writing',
  phaseGroup: 'D',
  triggers: ['续写', 'continue', '接着写', '下一章', '日更', '接上文', '继续写'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'recall', title: '召回上下文', instruction: '读取上一章结尾、本章细纲与角色/伏笔状态（经 story-recall）。' },
    { id: 'hook', title: '章首钩子', instruction: '用承接或反转开场，禁止重复上一章尾巴。' },
    { id: 'write', title: '正文展开', instruction: '按细纲推进冲突，一段一功能，控制说明比例。' },
    { id: 'end', title: '章末落点', instruction: '以悬念/爽点/信息差收尾，诱导追读。' },
    { id: 'gate', title: '质量自检', instruction: '过一遍去AI味与一致性要点，再交付（后续流水线强制门禁）。' },
  ],
  references: [
    { path: 'references/continue-playbook.md', desc: '续写节奏与视角一致性手册', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
