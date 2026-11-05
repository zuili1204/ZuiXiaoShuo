import type { Skill } from '@shared/types'

// 导入作者旧稿并恢复可续写事实；源文件只读，自动提取结果必须可复核
const skill: Skill = {
  id: 'story-import',
  name: '逆向导入',
  description:
    '将作者自己的 TXT/Markdown 小说导入并恢复为可续写、可审查的作品工程。保留章节顺序与完整正文，' +
    '分块恢复人物、时间线和伏笔，自动提取结果只作候选。触发：/story-import、「导入小说」「导入旧稿」「把我的书导进来」。',
  version: '2.0.0',
  category: 'import',
  triggers: ['导入', '解析', '上传', '已有小说', '反向', '把我的书', 'txt', 'story-import', '重建'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    { id: 'phase1_source', title: 'Phase 1 · 导入预检', instruction: '确认授权、源文件、编码、篇幅、目标作品和写入权限；源文件只读，已有同名作品或正文时先给冲突方案。' },
    { id: 'phase2_analyze', title: 'Phase 2 · 解析与校验', instruction: '按明确卷章标题切分，无卷标记的临时分组不冒充原书结构；核对章节数与字符量，抽查首尾、中段和边界章，报告空章、重复章号与截断风险。' },
    { id: 'phase3_migrate', title: 'Phase 3 · 分层恢复事实', instruction: '逐章恢复纪要、人物候选、时间线、认知与未结事项；昵称合并、关系与伏笔需证据，缺失和推断明确标注，每块可独立重跑。' },
    { id: 'phase4_tracking', title: 'Phase 4 · 初始化续写状态', instruction: '以实际最后一章和正文事实初始化追踪，不伪造逐章历史；工具成功返回后才报告项目、正文或追踪已写入。' },
    { id: 'phase5_deliver', title: 'Phase 5 · 续写就绪检查', instruction: '确认下一写作位置、上一章结尾、人物状态、活跃伏笔和时间线可用，列出低置信与冲突项；作者确认后再进入续写或 A6 重订。' },
  ],
  references: [
    { path: 'references/length-routing.md', desc: '篇幅分流判定', phase: '2' },
    { path: 'references/structure-mapping-long.md', desc: '长篇结构映射', phase: '3' },
    { path: 'references/structure-mapping-short.md', desc: '短篇结构映射', phase: '3' },
    { path: 'references/character-state-reverse.md', desc: '角色状态反推方法', phase: '3' },
    { path: 'references/state-tracking.md', desc: '状态追踪协议', phase: '4' },
    { path: 'references/tracking-transaction.md', desc: '追踪事务格式', phase: '4' },
    { path: 'references/format-and-structure.md', desc: '格式与结构规范', phase: '3' },
  ],
  scripts: [
    { path: 'scripts/tracking_commit.py', command: 'python scripts/tracking_commit.py {init|check}', desc: '追踪状态初始化与校验' },
  ],
}

export default skill
