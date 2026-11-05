import type { Skill } from '@shared/types'

// 表达修订：冻结剧情事实，按语境减少模板腔，不承诺 AI 检测分数
const skill: Skill = {
  id: 'story-deslop',
  name: '去AI味',
  description:
    '检测并减少网文中的模板腔、解释腔、重复反应和机械节奏，同时冻结剧情事实。' +
    '只改表达，不处理结构重写，不承诺任何 AI 检测分数。触发：/story-deslop、/去AI味、「去AI味」「文字润色」「自然化」。',
  version: '2.0.0',
  category: 'polish',
  triggers: ['去AI', '太AI', 'AI味', '润色', '自然', '去机械', 'story-deslop', '去味'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'phase1_scan', title: 'Phase 1 · 准备事实锚点', instruction: '列出场人物、事件、必要信息、伏笔、关系和章末状态；修订后逐项对账，结构与事实问题只标注。' },
    { id: 'phase2_grade', title: 'Phase 2 · 扫描与诊断', instruction: '工具可用时运行 check-ai-patterns.js 与 check-degeneration.js，保留真实行号和 severity；advisory 必须结合语境，不伪造脚本结果。' },
    { id: 'phase3_clean', title: 'Phase 3 · 最小表达改写', instruction: '先删无功能重复，再合并碎拍、把解释还给已有场景、保留人物声音和自然句长；不同义词轮换，不整段删除有功能内容。' },
    { id: 'phase4_finalize', title: 'Phase 4 · 作者风格与复扫', instruction: '有作者样本时第二次改句只迁移写法；落盘后按环境复扫，标点工具仅在符合作者习惯时使用，不为零提示破坏正常表达。' },
    { id: 'phase5_output', title: 'Phase 5 · 输出与停止', instruction: '输出修订文本、实际修改类型、字数变化和未解决项；只检测时不改原文，连续大面积重写则停止并转结构诊断。' },
  ],
  references: [
    { path: 'references/banned-words.md', desc: '禁用词表（一二级）', phase: '1-3' },
    { path: 'references/anti-ai-writing.md', desc: '去AI味完整指南（AI指纹/三遍法/范例/10+模式）', phase: '2-3' },
  ],
  scripts: [
    { path: 'scripts/check-ai-patterns.js', command: 'node scripts/check-ai-patterns.js --check --fail-on=blocking {file}', desc: 'AI句式预检与复扫（只报告）' },
    { path: 'scripts/check-degeneration.js', command: 'node scripts/check-degeneration.js --check {file}', desc: '退化检测（复读/截断/工程词泄漏）' },
    { path: 'scripts/normalize-punctuation.js', command: 'node scripts/normalize-punctuation.js {file}', desc: '标点机械兜底（清理 ……/——/---）' },
  ],
}

export default skill
