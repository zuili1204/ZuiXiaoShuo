import type { Skill } from '@shared/types'

const skill: Skill = {
  id: 'story-export',
  name: '小说导出',
  description: '将本地小说按范围导出为 Markdown、TXT 或 DOCX，检查缺失并验证实际文件；不自动上传、发布或投稿。',
  version: '2.0.0',
  category: 'derivative',
  phaseGroup: 'F',
  triggers: ['导出小说', '导出稿件', '导出DOCX', '导出TXT', '导出Markdown', 'story-export'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'scope', title: '确认导出合同', instruction: '确认作品、卷章范围、格式、标题选项、清理规则和保存位置；同名文件覆盖前先确认。' },
    { id: 'collect', title: '收集与检查', instruction: '按真实卷章顺序读取完整正文，核对数量、起止、空章、重复章号和读取失败，不静默跳过。' },
    { id: 'convert', title: '清理与转换', instruction: '移除内部标记和创作指令，按 md/txt/docx 正确生成文本或二进制文档，不只修改扩展名。' },
    { id: 'verify', title: '写出与验证', instruction: '确认文件存在且大小合理，抽查首尾章、范围、标题、编码与段落；成功后报告实际路径和缺失项。' },
  ],
  references: [],
  scripts: [],
}

export default skill
