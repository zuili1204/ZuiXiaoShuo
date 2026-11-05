import type { Skill } from '@shared/types'

// 长篇网文写作：情绪驱动 + 模块组装，5 Phase 流程（选题→设定→大纲→正文→检查）
// 完整指令见 SKILL.md，参考资料按 Phase 加载
const skill: Skill = {
  id: 'story-long-write',
  name: '长篇写作',
  description:
    '长篇网文创作总路由，覆盖开书、设定、大纲、黄金开篇、单章正文、日更续写、修订与状态管理。' +
    '具体任务优先交给专门技能；本技能负责判断阶段、组织上下文和控制停靠点。' +
    '触发：/story-long-write、/写长篇、「帮我开书」「写大纲」「黄金三章」「日更」「续写」「修改第X章」「大修」。',
  version: '2.0.0',
  category: 'writing',
  triggers: [
    '开书', '写大纲', '日更', '续写', '继续写', '修改', '回炉', '重写', '写第', '写长篇', 'story-long-write', '长篇',
    // 合并自 story-setup
    '立项', '初始化项目', 'story-setup',
    // 合并自 story-golden-opening
    '黄金三章', '开篇', '黄金开篇', 'story-golden-opening',
    // 合并自 story-continue
    '卡文', '救急', '续写方案', 'story-continue',
    // 合并自 story-revision
    '大修', '回炉重写', '重写整卷', 'story-revision',
  ],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'phase1_topic', title: 'Phase 1 · 判断项目状态', instruction: '识别当前只有灵感、缺设定、缺规划、待写正文、待续写或待修改；无法判断时列出下一步，不自动生成整本书。' },
    { id: 'phase2_setting', title: 'Phase 2 · 路由专门技能', instruction: '按任务路由立项、人物、世界观、大纲、开篇、写作、诊断、修订、摘要、召回或文风技能，不重复注入整套规则。' },
    { id: 'phase3_outline', title: 'Phase 3 · 建立读者承诺', instruction: '把书名、简介、题材和上一章期待列为承诺，检查核心卖点是否在动态场景中兑现并形成后续增量。' },
    { id: 'phase4_writing', title: 'Phase 4 · 写当前章', instruction: '读取细纲、上一章结尾、人物状态、规则和伏笔，按场景推进卡完成指定章节；多章必须逐章读取上一章实际定稿。' },
    { id: 'phase5_check', title: 'Phase 5 · 检查与停靠', instruction: '核对 hooks、事实、人物声音、关系增量和章尾待兑现事项；结构问题交诊断/修订，表达问题交 deslop，保存或追踪只有工具成功后才报告完成。' },
  ],
  references: [
    { path: 'references/workflow-setup.md', desc: '开书三阶段（Phase 1-3）完整步骤', phase: '1-3' },
    { path: 'references/workflow-daily.md', desc: '日更续写工作流', phase: '4' },
    { path: 'references/workflow-revision.md', desc: '大修回炉工作流', phase: '4' },
    { path: 'references/genre-catalog.md', desc: '题材分类目录', phase: '1' },
    { path: 'references/genre-readers.md', desc: '读者心理与平台差异', phase: '1' },
    { path: 'references/plot-special-topics.md', desc: '特殊题材（金手指等）', phase: '1' },
    { path: 'references/female-audience-writing.md', desc: '女频长篇写作', phase: '1' },
    { path: 'references/character-basics.md', desc: '人物基础设定', phase: '2' },
    { path: 'references/character-relations.md', desc: '关系与感情线设计', phase: '2' },
    { path: 'references/genre-core-mechanics.md', desc: '题材核心机制', phase: '2' },
    { path: 'references/artifact-protocols.md', desc: '产物文件模板', phase: '2' },
    { path: 'references/reader-contract-and-progression.md', desc: '读者契约与推进（权威）', phase: '2-5' },
    { path: 'references/outline-methods.md', desc: '大纲方法', phase: '3' },
    { path: 'references/outline-conflict.md', desc: '矛盾与结构设计', phase: '3' },
    { path: 'references/outline-structure-theory.md', desc: '深度结构理论', phase: '3' },
    { path: 'references/outline-rhythm.md', desc: '节奏与升级感', phase: '3' },
    { path: 'references/plot-core-methods.md', desc: '小纲与卡文方法', phase: '3' },
    { path: 'references/plot-frameworks.md', desc: '叙事框架选择', phase: '3' },
    { path: 'references/genre-writing-formulas.md', desc: '题材写作公式', phase: '3' },
    { path: 'references/opening-design.md', desc: '黄金三章设计', phase: '3' },
    { path: 'references/emotional-arc-design.md', desc: '情绪弧线设计', phase: '3' },
    { path: 'references/reversal-toolkit.md', desc: '反转工具箱', phase: '3' },
    { path: 'references/hooks-chapter.md', desc: '章节钩子', phase: '4' },
    { path: 'references/hooks-suspense.md', desc: '悬念设计', phase: '4' },
    { path: 'references/hooks-paragraph.md', desc: '段落级钩子', phase: '4' },
    { path: 'references/genre-prose-cards.md', desc: '题材正文提示卡索引', phase: '4' },
    { path: 'references/style-genre-modules.md', desc: '通用流派模块（兜底）', phase: '4' },
    { path: 'references/style-combat-face.md', desc: '打斗/装逼写法', phase: '4' },
    { path: 'references/style-craft.md', desc: '写作技法', phase: '4' },
    { path: 'references/commercial-core-methods.md', desc: '商业创作核心方法', phase: '4' },
    { path: 'references/dialogue-mastery.md', desc: '对话技巧', phase: '4' },
    { path: 'references/character-design-methods.md', desc: '人物深化方法', phase: '4' },
    { path: 'references/plot-emotion-system.md', desc: '情绪技法与叙事单元', phase: '4' },
    { path: 'references/emotional-methods.md', desc: '情绪方法', phase: '4' },
    { path: 'references/writing-craft.md', desc: '写作技法全程参考', phase: '4' },
    { path: 'references/format-and-structure.md', desc: '格式与结构规范', phase: '4' },
    { path: 'references/state-tracking.md', desc: '状态追踪协议', phase: '4' },
    { path: 'references/cross-book-recall.md', desc: '多对标书召回', phase: '4' },
    { path: 'references/quality-checklist.md', desc: '质量检查清单', phase: '5' },
    { path: 'references/banned-words.md', desc: '禁用词表', phase: '5' },
    { path: 'references/anti-ai-writing.md', desc: '去AI味完整指南', phase: '5' },
    { path: 'references/tracking-transaction.md', desc: '追踪事务格式', phase: '4' },
  ],
  scripts: [
    { path: 'scripts/tracking_commit.py', command: 'python scripts/tracking_commit.py {check|commit|init}', desc: '追踪状态权威工具（check/commit/init）' },
    { path: 'scripts/check-ai-patterns.js', command: 'node scripts/check-ai-patterns.js --check --fail-on=blocking {file}', desc: 'AI句式扫描（blocking 类必改）' },
    { path: 'scripts/check-degeneration.js', command: 'node scripts/check-degeneration.js --check {file}', desc: '退化防护扫描（复读/截断/工程词泄漏）' },
    { path: 'scripts/normalize-punctuation.js', command: 'node scripts/normalize-punctuation.js {file}', desc: '标点机械兜底（清理 ……/——/---）' },
  ],
}

export default skill
