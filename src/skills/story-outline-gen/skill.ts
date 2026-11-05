import type { Skill } from '@shared/types'

// 大纲生成：从设定书扩成卷级+章级大纲，含主线与支线
const skill: Skill = {
  id: 'story-outline-gen',
  name: '大纲生成',
  description:
    '大纲生成：从《作品设定书》扩成卷级+章级大纲，明确主线节奏、支线钩子与卷末爆点。' +
    '触发：/outline、/大纲、/细纲、「生成大纲」「写细纲」「章节大纲」「卷纲」。',
  version: '1.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['大纲', '细纲', 'outline', '章纲', '卷纲', '生成大纲', '章节大纲'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'spine', title: '主线骨架', instruction: '按「起承转合」或「目标-阻碍-代价」拉出全书主线。' },
    { id: 'volume', title: '卷级拆解', instruction: '每卷给核心事件、爽点密度、卷末爆点与情绪落点。' },
    { id: 'chapter', title: '章级细纲', instruction: '每章一句话钩子+冲突+落点，保证章末有悬念或爽点。' },
    { id: 'sub', title: '支线编排', instruction: '穿插 1-2 条支线，标注与主线交汇点，避免水剧情。' },
    { id: 'review', title: '自检节奏', instruction: '检查前 10 章钩子密度，低于阈值则补强开篇。' },
  ],
  references: [
    { path: 'references/outline-template.md', desc: '卷/章纲模板与节奏自检表', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
