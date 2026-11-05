import type { Skill } from '@shared/types'

// F4 拆书分析：把一本完整的书拆成可复用的创作资产（主线/分卷/角色/世界观/前三章骨架）
const skill: Skill = {
  id: 'story-deconstruct',
  name: '拆书分析',
  description:
    '拆书分析。导入一本完整的小说，AI 逐章提炼情节节拍、角色、世界观与文风，汇总成主线分卷与前三章骨架，沉淀为可复用的「我的模板」（新建小说时一键套用）。' +
    '触发：/story-deconstruct、/拆书、「拆书」「分析这本书」「学习这本书的写法」。',
  version: '1.0.0',
  category: 'derivative',
  triggers: ['拆书', '拆解', '分析这本书', '学习写法', 'deconstruct', '逆向大纲'],
  skillMd: 'SKILL.md',
  enabled: true,
  phaseGroup: 'F',
  steps: [
    { id: 'phase1_parse', title: 'Phase 1 · 导入与切章', instruction: '读取全书文本，按章节标记切分；超过采样上限时均匀抽样（首章、中段、末章必含），记录每章字数与标题。' },
    { id: 'phase2_analyze', title: 'Phase 2 · 逐章拆解', instruction: '对每个采样章节输出：场景一句话、出场角色（名字/定位/30字画像）、情节节拍、世界观信息、文风特征。单章正文截断 12000 字，避免超出预算。' },
    { id: 'phase3_merge', title: 'Phase 3 · 三次汇总', instruction: '汇总一：全书主线 + 分卷规划；汇总二：角色阵容 + 世界观条目 + 题材与简介；汇总三：前三章骨架（立世界、立主角、立冲突）。全部以 JSON 返回，解析失败时降级为启发式结果。' },
    { id: 'phase4_report', title: 'Phase 4 · 报告与模板落盘', instruction: '生成拆书报告 md（全书概览、主线、分卷、角色、世界观、文风、可借鉴点）写入拆书目录；同时产出模板 JSON 写入模板目录，供「新建小说」直接套用。' },
  ],
  references: [],
  scripts: [],
}

export default skill

