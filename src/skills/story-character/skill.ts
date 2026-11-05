import type { Skill } from '@shared/types'

// 角色塑造：生成有弧光、可记忆、能驱动剧情的人物卡
const skill: Skill = {
  id: 'story-character',
  name: '角色塑造',
  description:
    '角色塑造：生成有欲望、有缺陷、有成长弧光的人物卡——外在标签、内在动机、关系网、' +
    '关键转折与台词风格。触发：/char、/角色、/人设、「塑造人物」「配角」「反派」「人物卡」。',
  version: '1.0.0',
  category: 'worldbuilding',
  phaseGroup: 'B',
  triggers: ['角色', '人设', 'char', '人物', '配角', '反派', '塑造人物', '人物卡'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'desire', title: '欲望与缺陷', instruction: '先定角色最想要什么、最怕什么、致命缺陷是什么。' },
    { id: 'surface', title: '外在标签', instruction: '给出外貌/口头禅/习惯动作等易记忆信号，避免脸谱化。' },
    { id: 'relation', title: '关系网', instruction: '标注与主角及其他角色的爱恨羁绊，关系即戏剧。' },
    { id: 'arc', title: '成长弧光', instruction: '设计起点→转折→终点的变化曲线，确保角色随剧情成长。' },
    { id: 'voice', title: '台词风格', instruction: '给出角色专属语域示例，保证对话可辨识。' },
  ],
  references: [
    { path: 'references/character-sheet.md', desc: '人物卡模板与弧光设计示例', phase: '1-5' },
  ],
  scripts: [],
}

export default skill
