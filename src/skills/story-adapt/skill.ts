import type { Skill } from '@shared/types'

// 改编：把小说章节改编为漫画分镜/短剧脚本/有声大纲
const skill: Skill = {
  id: 'story-adapt',
  name: '改编工坊',
  description:
    '改编工坊：把小说章节改编为漫画分镜、短剧脚本或有声书大纲，保留原作基调并适配目标媒介的节奏与镜头语言。' +
    '触发：/adapt、/改编、/漫画分镜、/短剧、「改成剧本」「漫画化」「有声改编」。',
  version: '1.0.0',
  category: 'derivative',
  phaseGroup: 'F',
  triggers: ['改编', 'adapt', '漫画分镜', '短剧', '改成剧本', '漫画化', '有声改编'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'medium', title: '选媒介', instruction: '确认目标媒介（漫画/短剧/有声）及其节奏约束。' },
    { id: 'beat', title: '拆节拍', instruction: '把章节拆为可拍摄/可画的关键 beat，标注情绪与转场。' },
    { id: 'script', title: '出脚本', instruction: '按媒介格式产出分镜表/剧本/有声大纲。' },
    { id: 'tone', title: '保基调', instruction: '核对改编是否丢失原作 tone，补强缺失的氛围描写。' },
  ],
  references: [
    { path: 'references/adapt-formats.md', desc: '漫画/短剧/有声改编格式对照', phase: '1-4' },
  ],
  scripts: [],
}

export default skill
