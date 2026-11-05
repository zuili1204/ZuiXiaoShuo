import type { Skill } from '@shared/types'

// 写作 Agent：以工具调用方式先读取资料再撰写（文档 M2 / G4）
const skill: Skill = {
  id: 'story-agent-write',
  name: '写作 Agent',
  description:
    '写作 Agent：以工具调用能力先调取大纲/角色/世界观/追踪状态再落笔，真正实现"放手写、大胆写"，' +
    '彻底解决 AI 写作随心所欲、不读上下文的问题。' +
    '触发：/write、/写作、/续写agent、「帮我写」「按大纲写」。',
  version: '1.0.0',
  category: 'writing',
  phaseGroup: 'D',
  triggers: ['写作agent', 'agent写', '按大纲写', '帮我写', '调用资料写'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'profile', title: '确认本书', instruction: '调用 get_novel_profile 获取书名/题材/平台。' },
    { id: 'outline', title: '确认定位', instruction: '调用 get_outline 看清卷纲与本章细纲(hooks)。' },
    { id: 'character', title: '确认人物', instruction: '调用 get_character 核对出场角色性格/当前状态。' },
    { id: 'worldview', title: '确认设定', instruction: '调用 get_worldview 核对规则，避免冲突。' },
    { id: 'context', title: '确认上下文', instruction: '调用 get_chapter_context 承接上章。' },
    { id: 'tracking', title: '确认连续', instruction: '调用 get_tracking_state 查看活跃伏笔。' },
    { id: 'write', title: '落笔', instruction: '围绕细纲撰写正文，严格贴合资料。' },
    { id: 'commit', title: '提交追踪', instruction: '调用 commit_tracking 写入本章追踪状态。' },
  ],
  references: [],
  scripts: [],
}

export default skill
