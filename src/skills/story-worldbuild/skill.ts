import type { Skill } from '@shared/types'

// 世界观构建：系统化搭建可自洽的世界圣经（力量/地理/势力/历史/民俗）
const skill: Skill = {
  id: 'story-worldbuild',
  name: '世界观构建',
  description:
    '世界观构建：系统化搭建可自洽的世界圣经——力量体系、地理版图、势力格局、历史脉络、民俗与禁忌，' +
    '并输出「设定铁律清单」供一致性审查引用。触发：/world、/世界观、/设定、「构建世界」「力量体系」「势力图」。',
  version: '1.0.0',
  category: 'worldbuilding',
  phaseGroup: 'B',
  triggers: ['世界观', '世界', 'world', '力量体系', '势力', '地理', '设定圣经', '构建世界'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'pillar', title: '定支柱', instruction: '确定世界的核心奇观（如修炼/科技/魔法），所有设定围绕它自洽。' },
    { id: 'system', title: '力量/规则体系', instruction: '定义能级、上限、代价与越界后果，避免后期崩坏。' },
    { id: 'map', title: '地理与势力', instruction: '画出势力分布与关键地标，标注资源与冲突来源。' },
    { id: 'history', title: '历史与民俗', instruction: '补充 3-5 条影响当下的历史事件与民俗禁忌，增强真实感。' },
    { id: 'ironlaw', title: '输出铁律清单', instruction: '汇总不可违背的设定铁律，供 story-consistency 审查使用。' },
  ],
  references: [
    { path: 'references/world-bible.md', desc: '世界圣经模板与自洽性检查清单', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
