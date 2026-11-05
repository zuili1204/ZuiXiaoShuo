import type { Skill } from '@shared/types'

// 全书总结：跨章聚合为作品级备忘录（设定演化/主线进度/待回收伏笔）
const skill: Skill = {
  id: 'story-summarize',
  name: '全书总结',
  description:
    '全书总结：跨章聚合成作品级 JSON 备忘录——全书简介、各卷概要、当前进度、下一步方向。' +
    '由代码写入知识库 novel.md 与 volumes/*.md，供 AI 续写导航使用。' +
    '触发：/summarize、/全书总结、/总览、「整书概要」「作品备忘录」「回顾全书」。',
  version: '1.1.0',
  category: 'tracking',
  phaseGroup: 'D',
  triggers: ['全书总结', 'summarize', '作品备忘录', '整书概要', '回顾全书', '总览'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'aggregate', title: '聚合章节纪要', instruction: '合并各章 summary，提取跨章主线脉络。' },
    { id: 'volume', title: '卷概要', instruction: '为每卷产出主题/主线/卷尾钩子。' },
    { id: 'position', title: '当前进度', instruction: '标注当前写到第几卷第几章。' },
    { id: 'direction', title: '下一步方向', instruction: '给出接下来的写作方向（≤50字）。' },
    { id: 'json', title: '输出 JSON', instruction: '产出结构化 JSON（novel_summary/volume_summaries/current_position/next_direction），由代码写入知识库 novel.md 与 volumes/*.md。' },
  ],
  references: [
    { path: 'references/book-memo.md', desc: '全书备忘录模板', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
