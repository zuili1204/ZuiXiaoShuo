import type { Skill } from '@shared/types'

const skill: Skill = {
  id: 'story-style-lab',
  name: '作者文风实验室',
  description: '从作者旧作或参考语料建立文风画像、风格契约和融合配方，评估新章风格贴合度；只迁移写法，不搬运设定。',
  version: '2.0.0',
  category: 'worldbuilding',
  phaseGroup: 'B',
  triggers: ['文风分析', '作者风格', '风格复刻', '旧作语料', '风格锚点', '风格融合', 'style-lab'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'preflight', title: '语料预检', instruction: '确认来源、用途、范围和保存权限，保留原始语料，记录覆盖范围并选择首中后分层样本。' },
    { id: 'analyze', title: '定量与定性分析', instruction: '全量计算确定性指标，对分层样本分析写法；报告实际覆盖，部分失败不得伪装成完整画像。' },
    { id: 'contract', title: '聚合风格契约', instruction: '输出带证据、置信度、适用范围和例外的可执行规则，单次巧合不升级为硬约束。' },
    { id: 'redact', title: '锚点与脱敏', instruction: '按完整实体表处理所有字段和证据，检查专名、长引文与具体事件链；未通过则不入库。' },
    { id: 'apply', title: '融合与应用', instruction: '少量注入相关规则和锚点，先保证结构事实，再做只迁移写法的第二次改句。' },
    { id: 'evaluate', title: '评估与版本迭代', instruction: '按维度报告漂移、证据和修改建议；新画像保留版本，作者确认后切换绑定。' },
  ],
  references: [
    { path: 'references/style-contract.md', desc: '风格契约维度、规则结构与评估口径', phase: 'on-demand' },
  ],
  scripts: [],
}

export default skill
