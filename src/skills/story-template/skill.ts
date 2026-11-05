import type { Skill } from '@shared/types'

const skill: Skill = {
  id: 'story-template',
  name: '小说模板',
  description: '创建、审阅和应用原创小说模板，快速搭建题材、角色功能、世界锚点、主线分卷与开篇骨架；应用时保留已填内容。',
  version: '2.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['小说模板', '保存模板', '从模板开书', '应用模板', '题材模板', 'story-template'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'create', title: '创建模板', instruction: '提炼读者承诺、可重复故事发动机、角色功能、世界锚点、主线分卷和开篇骨架，用原创场景验证可生成故事。' },
    { id: 'review', title: '来源与脱敏检查', instruction: '参考作品模板只含抽象写法，不含原书设定和事件链；区分可复用结构与新书必须原创的素材。' },
    { id: 'diff', title: '应用前差异', instruction: '读取当前作品和模板版本，列出保留项、拟补空项、冲突项和需要作者选择项。' },
    { id: 'apply', title: '确认后应用', instruction: '只向空字段填提案，不静默覆盖；作者确认且工具成功后才报告创建或应用完成。' },
  ],
  references: [],
  scripts: [],
}

export default skill
