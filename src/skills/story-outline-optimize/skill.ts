import type { Skill } from '@shared/types'

// 大纲优化：对已有大纲做节奏/逻辑/爽点体检并给出改写方案
const skill: Skill = {
  id: 'story-outline-optimize',
  name: '大纲优化',
  description:
    '大纲优化：对已有大纲做节奏体检、逻辑补漏与爽点提效，定位拖沓段与断档点并给出改写方案。' +
    '触发：/optimize、/优化大纲、/改纲、「大纲太水」「节奏慢」「润色大纲」「调纲」。',
  version: '2.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['优化大纲', '改纲', 'optimize', '调纲', '大纲太水', '节奏慢', '润色大纲'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'diag', title: '基线与范围', instruction: '区分已写正文事实与未写规划，明确优化目标、冻结项和允许调整的范围。' },
    { id: 'logic', title: '根因诊断', instruction: '检查任务、信息、人物决定、关系与情绪增量，定位重复、断档、动机和伏笔问题，不用固定低强度章数直接判水。' },
    { id: 'pace', title: '最小补丁', instruction: '只给确需变化的未写章生成 summary/hooks 补丁，保留有效结构并说明连带影响。' },
    { id: 'rewrite', title: '确认后应用', instruction: '作者确认且工具成功后才写回；已写章正文、摘要和 hooks 只读，不静默重排。' },
  ],
  references: [
    { path: 'references/optimize-checklist.md', desc: '大纲优化体检清单', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
