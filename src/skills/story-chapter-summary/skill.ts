import type { Skill } from '@shared/types'

// 章节总结：把一章正文压缩为结构化纪要，供续写召回与追踪
const skill: Skill = {
  id: 'story-chapter-summary',
  name: '章节总结',
  description:
    '章节总结：把一章正文压缩为结构化 JSON 纪要——摘要、关键事件、出场角色、新增/回收伏笔、下章钩子。' +
    '由代码写入知识库 chapters/<chId>.md + hooks.md + foreshadowings.md，供续写导航与 tracking 状态卡使用。' +
    '触发：/summary、/章结、/总结章、「本章概要」「章节纪要」「完成本章」按钮。',
  version: '1.0.0',
  category: 'tracking',
  phaseGroup: 'D',
  triggers: ['章结', '章节总结', 'summary', '本章概要', '章节纪要', '总结章'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'plot', title: '事件提取', instruction: '列出本章发生的关键事件，按剧情重要性排序。' },
    { id: 'thread', title: '线索推进', instruction: '标注主线/支线的前进量与停滞量。' },
    { id: 'foreshadow', title: '伏笔账', instruction: '区分「新埋伏笔」与「已回收伏笔」，写入追踪状态。' },
    { id: 'char', title: '角色变化', instruction: '记录主要角色的位置/关系/认知变化。' },
    { id: 'hook', title: '下章钩子', instruction: '给出本章结尾留下的悬念，指向下一章该兑现什么。' },
    { id: 'json', title: '输出 JSON', instruction: '产出结构化 JSON（summary/keyEvents/charactersInvolved/newForeshadowings/resolvedForeshadowings/nextChapterHook），由代码写入知识库 chapters/<chId>.md。' },
  ],
  references: [
    { path: 'references/summary-schema.md', desc: '章节纪要结构化 schema', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
