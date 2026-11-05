import type { Skill } from '@shared/types'

// 开书规划工作台：A1-A6 专用执行规范，负责结构化契约、字数预算与已写章保护
const skill: Skill = {
  id: 'story-plan-workspace',
  name: '开书规划工作台',
  description:
    '开书规划工作台专用技能。按 A1 立项 → A2 主线分卷 → A3 卷章纲 → A4 章细纲 → A5 体检 → A6 重订逐层产出结构化提案；' +
    '保护用户已填事实与已写章节，所有产出先提案、后落库。' +
    '触发：/plan-workspace、/开书规划、「规划工作台」「卷章纲」「章细纲」「重订走向」。',
  version: '2.0.0',
  category: 'outline',
  phaseGroup: 'C',
  triggers: ['开书规划', '规划工作台', 'plan-workspace', '卷章纲', '章细纲', '重订走向'],
  skillMd: 'SKILL.md',
  enabled: true,
  steps: [
    {
      id: 'a1_seed',
      title: 'A1 · 立项书',
      instruction:
        '读取 PlanBrief 与已有小说信息，只补缺失维度，用户已填项原样保留。输出书名备选、题材、一句话梗概、简介、核心冲突、角色、世界观锚点、卖点、基调、读者与 warnings。最多提 3 个澄清问题，不展开无关世界观。',
    },
    {
      id: 'a1_assist',
      title: 'A1+ · 单块线索规划',
      instruction:
        '只补全或重规划用户指定的一个线索块（类型/书名/梗概/冲突/主角/其他角色/世界观/时代/能力/卖点/基调/对标/禁忌）。必须围绕所有已填线索（含草稿区）生成 1-5 条可直接填入该字段的完整建议，不越界生成其他块；目标块已有内容时给出明显不同的更好替代；与用户明确写下的设定冲突时写入 warnings。多条候选要沿不同轴发散（轻喜剧/关系流/悬疑感，或日常仪式/公共事件/误会链），每条尽量给出轴标签、一个可重复发生的具体场面、命中的功能位与 ≤60 字的好看理由。作者给出的方向与口味优先于默认偏好；默认按当下网文/轻小说期待，先写能发生的好看场面与关系推进，避免枷锁、代价、倒计时等苦情框架和过时疼痛腔。',
    },
    {
      id: 'a2_master',
      title: 'A2 · 主线与分卷',
      instruction:
        '产出全书主线与分卷列表，明确每卷职责、卷目标、可重复单元、卷末高潮、卷尾钩子与预计章数。卷与卷之间至少升级关系、信息、舞台中的一项，不默认用“代价更高”升级。卷数 × 章数 × 单章字数必须与用户期望总字数兼容，偏离超过 20% 写入 warnings。不写章级细节。',
    },
    {
      id: 'a3_volume',
      title: 'A3 · 卷章纲',
      instruction:
        '只为指定卷生成章骨架：章名、hooks、冲突、转折、落点、章末类型、目标字数。每章至少完成公共事件、关系标签变化、信息揭示、可复用名场面中的一项；允许状态维持章，章末停在画面/动作/台词/信息/未完成动作/误会，禁止总结升华；已写章跳过；首卷前三章执行黄金三章检查。',
    },
    {
      id: 'a4_chapter',
      title: 'A4 · 章细纲',
      instruction:
        '把一句话骨架细化成 3-6 条可执行 hooks，补 summary、targetWordCount 与 continuityNotes。必须承接上一章钩子并为下一章留钩；已写正文的章拒绝生成。',
    },
    {
      id: 'a5_review',
      title: 'A5 · 大纲体检',
      instruction:
        '工具可用时先运行 check-plan-health.js；只有章节含显式伏笔标记时才运行伏笔对账脚本。保留真实输出，再补动机、节奏、升级感等模型判断。输出 blocking/warning/info 问题与可选补丁，不直接修改任何内容。',
    },
    {
      id: 'a6_calibrate',
      title: 'A6 · 重订走向',
      instruction:
        '以已写事实为基准，只调整确需变化的未写章，输出旧走向 → 新走向差异与连带影响。已写章条目直接丢弃；不改变书名、简介与已写正文。',
    },
  ],
  references: [
    { path: 'references/plan-brief.md', desc: 'PlanBrief 字段语义与缺失项处理', phase: 'A1' },
    { path: 'references/proposal-contracts.md', desc: 'A1-A6 JSON 字段、范围与禁止项', phase: 'A1-A6' },
    { path: 'references/anti-ai-planning.md', desc: '规划层反模板准则、证据要求与改写方法', phase: 'A1-A6' },
    { path: 'references/seed-card.md', desc: '立项书模板与坏/好对比', phase: 'A1' },
    { path: 'references/sample-seed.md', desc: '立项书分字段坏/好样本', phase: 'A1' },
    { path: 'references/volume-budget.md', desc: '总字数/卷字数/章数/单章字数换算', phase: 'A2-A3' },
    { path: 'references/chapter-skeleton.md', desc: '章骨架、hooks 类型与黄金三章检查', phase: 'A3-A4' },
    { path: 'references/sample-volume.md', desc: '卷章纲坏/好样本与章型分布', phase: 'A3' },
    { path: 'references/sample-chapter.md', desc: '章细纲 hooks 坏/好样本', phase: 'A4' },
    { path: 'references/outline-health.md', desc: '体检项、severity 与补丁边界', phase: 'A5' },
    { path: 'references/recalibrate.md', desc: '重订规则、已写章保护与连带影响', phase: 'A6' },
  ],
  scripts: [
    {
      path: 'scripts/validate-proposal.js',
      command: 'node scripts/validate-proposal.js --stage=<stage> --file=<json>',
      desc: '提案结构、范围与已写章保护校验',
    },
    {
      path: 'scripts/check-plan-health.js',
      command: 'node scripts/check-plan-health.js --file=<json>',
      desc: '空 hooks/重复章名/预算漂移/强度断层检查',
    },
  ],
}

export default skill
