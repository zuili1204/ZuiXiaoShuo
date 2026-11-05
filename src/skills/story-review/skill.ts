import type { Skill } from '@shared/types'

// 只读诊断：按根因与严重度排序，不在审查中直接改稿
const skill: Skill = {
  id: 'story-review',
  name: '多视角审查',
  description:
    '对正文或大纲做只读诊断，覆盖开篇兑现、结构因果、人物声音、信息差、情绪推进、节奏和章尾。' +
    '修改交给 story-revision 或 story-deslop。触发：/story-review、/审查、「审查一下」「章节体检」「问题定位」。',
  version: '2.0.0',
  category: 'review',
  triggers: ['审查', '审一下', '检查', '诊断', '问题', '结构', '节奏', '一致性', '把关', 'story-review'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'phase0_preflight', title: 'Phase 0 · 范围与基线', instruction: '明确审查范围、题材、读者和作者意图，概括实际任务、人物选择与状态变化；抽样不得冒充全书逐章审查。' },
    { id: 'view_structure', title: '视角 · 结构与信息', instruction: '检查目标、阻力、选择、结果、因果、视角认知与揭示后的行动变化，定位根因而非只摘错句。' },
    { id: 'view_character', title: '视角 · 人物与关系', instruction: '检查人物策略与声音差异、反应是否影响下一句、关系新基线和严重情绪后的过渡与后果。' },
    { id: 'view_prose', title: '视角 · 节奏与语言', instruction: '检查重复证明、标题事件延迟、句段节拍和解释腔；工具结果只作证据，正常词汇不作绝对禁令。' },
    { id: 'view_consistency', title: '视角 · 事实与伏笔', instruction: '核对事实、时间线、认知、物件与伏笔；脚本不可用时说明，未运行不得声称全书检查通过。' },
    { id: 'report', title: '输出 · 优先问题', instruction: '按 blocking/warning/info 输出位置、证据、根因和最小建议，同时列出应保留优点与不超过三轮的修改顺序。' },
  ],
  references: [
    { path: 'references/quality-rubric.md', desc: '通用质量评分卡', phase: '0' },
    { path: 'references/quality-checklist.md', desc: '质量检查清单', phase: 'all' },
    { path: 'references/plot-core-methods.md', desc: '结构/高潮方法', phase: 'structure' },
    { path: 'references/character-relations.md', desc: '角色关系', phase: 'character' },
    { path: 'references/dialogue-mastery.md', desc: '对话技巧', phase: 'character' },
    { path: 'references/anti-ai-writing.md', desc: '去AI味指南（文字视角）', phase: 'prose' },
    { path: 'references/banned-words.md', desc: '禁用词表（文字视角）', phase: 'prose' },
    { path: 'references/tracking-transaction.md', desc: '追踪事务（一致性视角）', phase: 'consistency' },
    { path: 'references/rubrics/fanqie.md', desc: '番茄 rubric', phase: '0' },
    { path: 'references/rubrics/qidian.md', desc: '起点 rubric', phase: '0' },
    { path: 'references/rubrics/zhihu.md', desc: '知乎 rubric', phase: '0' },
  ],
  scripts: [
    { path: 'scripts/check-ai-patterns.js', command: 'node scripts/check-ai-patterns.js --check --fail-on=blocking {file}', desc: 'AI句式扫描（文字视角辅助）' },
    { path: 'scripts/check-degeneration.js', command: 'node scripts/check-degeneration.js --check {file}', desc: '退化检测' },
    { path: 'scripts/normalize-punctuation.js', command: 'node scripts/normalize-punctuation.js {file}', desc: '标点机械兜底' },
    { path: 'scripts/tracking_commit.py', command: 'python scripts/tracking_commit.py check', desc: '追踪状态校验（一致性视角）' },
  ],
}

export default skill
