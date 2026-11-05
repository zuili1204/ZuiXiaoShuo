import type { Skill } from '@shared/types'

// 跨章召回：流水线内置的 RAG 检索（不显式触发），为续写/审查提供上下文
const skill: Skill = {
  id: 'story-recall',
  name: '跨章召回',
  description:
    '跨章召回（RAG）：流水线内置的确定性上下文检索，按当前写作意图召回相关历史章节/设定/伏笔，' +
    '不显式触发，由 agent 在续写与审查时自动调用。触发：（流水线内置，无显式命令）。',
  version: '2.0.0',
  category: 'derivative',
  phaseGroup: 'F',
  triggers: ['召回', 'recall', 'rag', '上下文检索', '相关章节'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'embed', title: '索引', instruction: '章节落盘即写入向量索引（由 rag-service 维护）。' },
    { id: 'query', title: '查询构造', instruction: '以当前细纲+角色名+伏笔关键词构造检索 query。' },
    { id: 'retrieve', title: '召回', instruction: '按当前运行环境与上下文预算取少量相关片段，去重并标明来源；正文事实优先于旧摘要和未写规划。' },
    { id: 'inject', title: '注入', instruction: '经 buildContextString 注入 agent 系统提示，供续写/审查引用。' },
  ],
  references: [
    { path: 'references/recall-strategy.md', desc: '召回策略与上下文预算说明', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
