export interface Novel {
  id: string
  title: string
  description: string
  coverPath?: string | null
  genre: string[]
  targetPlatform: string
  status: 'planning' | 'writing' | 'completed' | 'draft'
  wordCount?: number
  chapterCount?: number
  /** 全书主线（写作前规划事实源；outline.md 由其与卷章派生） */
  masterOutline?: string
  /** P4：系列书分组与系列内序号，空表示不属于系列 */
  seriesName?: string
  seriesOrder?: number
  createdAt: string
  updatedAt: string
}

export interface Volume {
  id: string
  novelId: string
  title: string
  order: number
  summary: string
  /** A2 契约扩展字段；旧数据为空 */
  goal?: string
  climax?: string
  endingHook?: string
  estimatedChapters?: number
  targetWordCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface Chapter {
  id: string
  volumeId: string
  title: string
  order: number
  contentPath: string
  wordCount: number
  status: 'draft' | 'reviewed' | 'polished' | 'final'
  targetWordCount: number
  hooks: string[]
  summary?: string
  createdAt: string
  updatedAt: string
}

// ===== 场景卡（P0：章级 hooks 的执行层） =====
export type SceneCardStatus = 'planned' | 'writing' | 'written' | 'cut'

export interface SceneCard {
  id: string
  chapterId: string
  novelId: string
  orderNum: number
  title: string
  goal: string
  obstacle: string
  turn: string
  outcome: string
  emotionBefore: string
  emotionAfter: string
  location: string
  storyTime: string
  characters: string[]
  props: string[]
  hooks: string[]
  status: SceneCardStatus
  wordTarget: number
  createdAt: string
  updatedAt: string
}

export interface Character {
  id: string
  novelId: string
  name: string
  role: 'protagonist' | 'antagonist' | 'supporting' | 'functional'
  // 基础信息
  gender?: 'male' | 'female' | 'other' | 'unknown'
  age?: string
  // 结构化设定
  personality?: string   // 性格特点
  appearance?: string     // 外貌描写
  profile: string         // 角色档案 / 背景设定
  dynamicState: string   // 当前动态
  createdAt?: string
  updatedAt?: string
}

export interface Foreshadowing {
  id: string
  novelId: string
  content: string
  plantedChapter: number
  plannedResolveChapter?: number
  resolvedChapter?: number
  status: 'planted' | 'partial' | 'resolved'
  importance: 'major' | 'minor'
}

// ===== P1：Story State（角色状态 / 时间线 / 剧情线） =====

export type CharacterStatus = 'active' | 'dead' | 'missing' | 'retired'

export interface CharacterKnowledge {
  knows: string[]
  suspects: string[]
  unaware: string[]
}

export interface CharacterItem {
  name: string
  state?: string
  acquiredChapter?: number
}

export interface CharacterAbility {
  name: string
  level?: string
  unlockedChapter?: number
  limits?: string
}

export interface CharacterRelationship {
  targetId: string
  type: string
  status?: string
  sinceChapter?: number
}

/** 按章追加的角色动态状态；最新一章即“当前状态”。 */
export interface CharacterState {
  id: string
  novelId: string
  characterId: string
  chapterId: string
  chapterOrder: number
  location: string
  knowledge: CharacterKnowledge
  items: CharacterItem[]
  abilities: CharacterAbility[]
  relationships: CharacterRelationship[]
  status: CharacterStatus
  note: string
  createdAt: string
}

export type TimelineEventKind = 'plot' | 'character' | 'world'
export type TimelineEventSource = 'author' | 'reader'

export interface TimelineEvent {
  id: string
  novelId: string
  chapterId: string
  chapterOrder: number
  storyTime: string
  event: string
  location: string
  characters: string[]
  kind: TimelineEventKind
  source: TimelineEventSource
  createdAt: string
}

export type PlotThreadKind = 'main' | 'sub' | 'foreshadow' | 'romance'
export type PlotThreadStatus = 'open' | 'partial' | 'resolved' | 'abandoned'

export interface PlotThread {
  id: string
  novelId: string
  title: string
  kind: PlotThreadKind
  status: PlotThreadStatus
  plantedChapter?: number
  plannedResolveChapter?: number
  resolvedChapter?: number
  /** 1~5，越高越紧急 */
  urgency: number
  lastTouchedChapter?: number
  payoffPlan: string
  foreshadowingIds: string[]
  createdAt: string
  updatedAt: string
}

// P2：扩展 Agent 角色至 7 个专业角色（对齐 oh-story 多 Agent 编排）
export type AgentRole =
  | 'architect'   // 架构师：结构诊断、大纲、节奏
  | 'writer'      // 作者：正文写作
  | 'polisher'    // 润稿者：去AI味、文风统一
  | 'checker'     // 质检：一致性、伏笔
  | 'planner'     // 规划师：意图拆解、子任务派发
  | 'runtime'     // 运行时：调度与检查点管理
  | 'director'    // 导演：全局编排、审批决策
  | 'consistency' // 一致性专员：跨章事实/时间线/设定核查

export interface AgentConfig {
  id: string
  name: string
  role: AgentRole
  provider: string
  model: string
  endpoint?: string       // provider='custom' 时的自定义接口地址（chat/completions 完整 URL 或 base URL）
  temperature: number
  maxTokens: number
  topP?: number          // 核采样；不填则请求体不附加（走模型/厂商默认）
  apiKeyEncrypted?: string
  systemPrompt: string
  skillRefs: string[]
  isActive: boolean
}

export interface ChatMessage {
  id: string
  novelId: string
  chapterId?: string
  agentId?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokensUsed: number
  createdAt: string
}

export interface PipelineStage {
  agentRole: AgentRole
  label: string
  autoApprove: boolean
  // 该阶段产出后强制执行的技能（如 polisher 阶段后强制 deslop Gate）
  gateSkills?: string[]
}

export interface PipelineConfig {
  id: string
  name: string
  stages: PipelineStage[]
}

// ===== Skill System =====
export interface SkillStep {
  id: string
  title: string
  instruction: string
}

export interface SkillReference {
  // 相对 skill 根的路径，如 "references/workflow-setup.md"
  path: string
  // 简述
  desc: string
  // 加载场景（Phase 1/2/3/4/5 或 "on-demand"）
  phase?: string
}

export interface SkillScript {
  // 相对 skill 根的路径，如 "scripts/check-ai-patterns.js"
  path: string
  // 运行命令模板（{file} 为正文文件占位）
  command: string
  desc: string
}

// P1：扩展技能分类以支持六阶段技能版图（A立项/B设定/C大纲/D写作/E审查/F衍生）
export type SkillCategory =
  | 'writing'
  | 'review'
  | 'polish'
  | 'import'
  | 'general'
  | 'ideation'     // A 立项：点子孵化、扫描、立项
  | 'worldbuilding' // B 设定：世界观、角色
  | 'outline'      // C 大纲：大纲生成/优化、黄金三章、弧光
  | 'tracking'     // D 写作：续写、章节总结、全书总结
  | 'derivative'   // F 衍生：RAG召回、封面、改编

export interface Skill {
  id: string
  name: string
  description: string
  version: string
  category: SkillCategory
  // 适用场景关键词，用于 agent 自动选技能
  triggers: string[]
  // 结构化步骤（Phase 流程摘要）
  steps: SkillStep[]
  // SKILL.md 完整指令文件相对路径（相对 skill 根）
  skillMd: string
  // 参考资料索引
  references: SkillReference[]
  // 确定性脚本工具
  scripts: SkillScript[]
  // 是否默认启用
  enabled: boolean
  // 六阶段分组标识（A~F），用于 UI 分组展示与路由去重
  phaseGroup?: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
}

// ===== 质量门禁（P0） =====
// 单条质检发现（AI 味/退化/文风指标的行级结果，供「AI 率检测」面板逐条展示）
export interface QualityFinding {
  line: number
  type: string
  severity: 'blocking' | 'advisory'
  message: string
  excerpt: string
  source: 'ai-patterns' | 'degeneration' | 'style-metrics'
}

export interface QualityGate {
  score: number          // 0-100 综合质量分
  passed: boolean        // 是否通过门禁
  deslopTag: boolean     // 是否通过去AI味
  aiPatternHits: number  // AI 句式命中数
  degenerationHits: number // 退化命中数
  report?: string        // 质量报告文本
  checkedAt: string
  findings?: QualityFinding[] // 行级发现（脚本检测透传；启发式降级时缺省）
}

// ===== 作者解放度（文档 2.4） =====
export type LiberationLevel = 'L1' | 'L2' | 'L3' | 'L4'

// ===== 导演式编排 / 检查点（P2） =====
export interface DirectorTask {
  id: string
  novelId: string
  intent: string                 // 用户自然语言意图
  level?: LiberationLevel        // 作者解放度（审批分级依据，P6 落库）
  decomposed: SubTask[]          // 拆解后的子任务
  status: 'pending' | 'running' | 'paused' | 'completed' | 'awaiting-approval'
  createdAt: string
  updatedAt: string
}

export interface SubTask {
  id: string
  agentRole: AgentRole
  skillRefs: string[]
  input: string
  dependsOn?: string[]
  autoApprove: boolean
  status: 'pending' | 'running' | 'completed' | 'rejected'
  output?: string
  quality?: QualityGate
}

// 检查点：每阶段产出落库，支持断点续跑
export interface Checkpoint {
  id: string
  taskId: string
  novelId: string
  stageIndex: number
  agentRole: AgentRole
  // 任务意图与子任务输入的快照：断点续跑时用于重建 DirectorTask
  // （对应 director_checkpoints 表的 intent / input 列，见 tracking-service.rowToCheckpoint）
  intent?: string
  input?: string
  output: string
  quality?: QualityGate
  status: 'running' | 'completed' | 'awaiting-approval' | 'paused'
  createdAt: string
}

// ===== 世界观（文档 G6 / M6） =====
export type WorldviewCategory =
  | 'power'
  | 'geography'
  | 'history'
  | 'cultivation'
  | 'society'
  | 'magic'
  | 'tech'
  | 'other'

export interface Worldview {
  id: string
  novelId: string
  category: WorldviewCategory
  title: string
  content: string
  createdAt?: string
  updatedAt?: string
}

// ===== 势力设定（Force） =====
export type ForceType =
  | 'sect'         // 门派/宗门
  | 'empire'       // 帝国/王朝
  | 'organization' // 组织/帮会
  | 'family'       // 家族
  | 'guild'        // 公会/商会
  | 'army'         // 军队/势力
  | 'other'

export interface Force {
  id: string
  novelId: string
  name: string
  type: ForceType
  level?: string               // 等级/实力描述
  description: string         // 势力描述
  protagonistRelation?: string // 与主角关系
  coreMembers?: string         // 核心成员
  territory?: string           // 领地/势力范围
  createdAt?: string
  updatedAt?: string
}

// ===== 写作 Agent 上下文（文档 M1 核心修复） =====
export type AgentMode = 'ask' | 'writing' | 'director'

export interface ContextSummary {
  novelTitle: string
  novelDescription?: string
  genre: string[]
  targetPlatform?: string
  volumeTitle?: string
  currentChapterTitle?: string
  currentChapterOrder?: number
  totalChapters: number
  totalWordCount: number
  committedChapters: number
  activeForeshadowings: number
  characters: number
}

export type ContextTask = 'write' | 'revise' | 'check' | 'ask'

export type ContextSectionKey =
  | 'safety'
  | 'canon'
  | 'scene'
  | 'current'
  | 'previous'
  | 'state'
  | 'rag'
  | 'style'
  | 'history'

export interface ContextSection {
  key: ContextSectionKey
  /** 1 最高；数值越大越先被裁剪 */
  priority: number
  tokens: number
  included: boolean
  /** 入选/裁剪原因（用户可见的简短说明） */
  reason?: string
  /** 预览用：经预算裁剪后的最终文本 */
  content?: string
}

export interface ContextPlan {
  task: ContextTask
  budgetTokens: number
  totalTokens: number
  sections: ContextSection[]
  dropped: { key: ContextSectionKey; reason: string; tokens?: number }[]
  /** 各区块经预算裁剪后的文本（按区块 key） */
  rendered?: Partial<Record<ContextSectionKey, string>>
  /** 历史消息可用预算（由调用方按此裁剪 previousMessages） */
  historyBudgetTokens?: number
}

export interface ContextPlanOverrides {
  /** 预算不足时也不裁剪 */
  pin?: ContextSectionKey[]
  /** 本次生成不注入 */
  exclude?: ContextSectionKey[]
}

export interface ContextBundle {
  novelId: string
  /** 上下文预算计划（装配时产出，供预览与裁剪日志使用） */
  contextPlan?: ContextPlan
  summary: ContextSummary
  novel: { title: string; description: string; genre: string[]; targetPlatform: string }
  outline: string
  currentChapter?: {
    title: string
    order: number
    summary?: string
    hooks: string[]
    content?: string
  }
  adjacentChapters: {
    prev?: { title: string; order: number; summary?: string; content?: string }
    next?: { title: string; order: number; hooks?: string[] }
  }
  characters: Character[]
  charactersText: string
  worldviews: Worldview[]
  worldviewsText: string
  forces: Force[]
  forcesText: string
  foreshadowView: string
  trackingStateCard: string
  /** 本章场景卡（施工图）：逐场写作/重写的执行依据 */
  sceneCards?: SceneCard[]
  ragContext: string
  navigationContext: string  // 知识库导航层（novel.md + 当前卷 + 当前章 + foreshadowings + hooks）
  /** P2：融合文风提示词（只影响表达方式，不影响事实） */
  styleContext?: string
  styleMeta?: {
    recipeId: string
    recipeName: string
    strength: number
    sourceNames: string[]
  }
  previousMessages: { role: string; content: string }[]
}

export interface BuildContextOptions {
  novelId?: string
  volumeId?: string
  chapterId?: string
  chapter?: Chapter | null
  chapterContent?: string
  /** 重新生成场景：本章旧稿（编辑器/磁盘）不得进入上下文，避免 writer 把旧稿当续写基准逐字复述 */
  excludeCurrentChapterContent?: boolean
  chapterTitle?: string
  chapterOrder?: number
  chapterSummary?: string
  chapterHooks?: string[]
  previousMessages: { role: string; content: string }[]
  /** 上下文窗口（token）；缺省按 32000 规划 */
  contextWindowTokens?: number
  /** 上下文计划任务类型；缺省按模式推断 */
  contextTask?: ContextTask
  /** 用户固定/排除的区块；缺省读取本书已保存的偏好 */
  contextPlanOverrides?: ContextPlanOverrides
  /** P1 连贯性门禁：blocking=硬伤拦截（默认），advisory=只记录，off=关闭 */
  continuityGate?: 'blocking' | 'advisory' | 'off'
  /** P2：本次不注入文风（质量门禁/合规检查等场景） */
  excludeStyle?: boolean
  /**
   * 覆盖系统提示词里的技能段（规划工作台用）。
   * 传入时不再按 agent.skillRefs / 触发词自动加载技能，避免规划调用命中无关技能。
   */
  skillPromptOverride?: string
  mode?: 'chat' | 'craft'
  agentMode?: AgentMode
  enableTools?: boolean
  plan?: string
  maxIterations?: number
  onToolEvent?: (e: AgentLoopEvent) => void
}

// ===== Agent 工具层（文档 M2 核心修复） =====
export interface AgentToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  enum?: string[]
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, AgentToolParameter>
  handler: (args: any) => Promise<any>
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: string
}

export interface AgentToolResult {
  id: string
  name: string
  success: boolean
  result: any
  error?: string
}

export type AgentLoopEvent =
  | { type: 'tool_use'; id: string; name: string; arguments: any }
  | { type: 'tool_result'; id: string; name: string; result: AgentToolResult }
  | { type: 'message'; content: string }
  | { type: 'iteration'; index: number; max: number }

// ===== 大纲向导 / 重订走向（8.13） =====

/**
 * 弹性输入种子：写作前用户可只填任意子集（书名 / 类型 / 角色 / 梗概），
 * 缺失维度交给 AI 提案，用户确认后才生效。
 */
export interface OutlineSeed {
  title?: string
  genre?: string
  /** 自由文本，多行；如「江砚 —— 高三转学生，喜欢修旧钟表」 */
  characters?: string
  premise?: string
  /** 世界设定/铁律：力量体系、社会规则、关键地点等 */
  worldview?: string
  /** 基调与目标读者，如「冷峻悬疑，面向成年读者」 */
  tone?: string
  /** 核心冲突一句话：谁想要什么、被什么阻挡、代价是什么 */
  coreConflict?: string
  /** 主角：姓名 + 身份 / 欲望 / 缺陷 */
  protagonist?: string
  /** 时代与地点 */
  setting?: string
  /** 金手指 / 力量体系 / 核心能力 */
  power?: string
  /** 卖点与爽点，自由文本（可多行） */
  sellingPoints?: string
  /** 对标作品 / 参考 */
  references?: string
  /** 禁忌与雷点：明确不要写的东西 */
  taboos?: string
  /** 草稿区：随手记录，AI 规划时一并参考 */
  draft?: string
  volumeCount?: number
  chapterCount?: number
}

/** 逐块 AI 规划可作用于哪些线索 */
export type SeedAssistField =
  | 'genre'
  | 'title'
  | 'premise'
  | 'coreConflict'
  | 'protagonist'
  | 'characters'
  | 'worldview'
  | 'setting'
  | 'power'
  | 'sellingPoints'
  | 'tone'
  | 'references'
  | 'taboos'

export type SeedFindingSeverity = 'blocking' | 'warning' | 'info'

export interface SeedSuggestionFinding {
  code: string
  message: string
  severity: SeedFindingSeverity
  /** 问题出现的位置，如「候选2」「第3章」 */
  location?: string
  /** 触发问题的原文片段，供作者核对 */
  evidence?: string
  /** 一句可执行的修改方向 */
  suggestion?: string
}

export interface SeedSuggestionScore {
  /** 新鲜度：是否命中过时模板 */
  freshness: number
  /** 可写性：能否直接写成一个场面 */
  writability: number
  /** 连载性：能否反复发生 */
  seriality: number
  /** 贴合度：是否符合目标字段与已填线索 */
  fit: number
  overall: number
}

/** 结构化建议：text 可直接填入字段，其余字段用于解释与验收 */
export interface SeedSuggestion {
  text: string
  /** 候选轴，如 轻喜剧 / 关系流 / 悬疑感 / 日常仪式 */
  axis?: string
  /** 一个能发生、可重复的具体场面 */
  scene?: string
  /** 命中的功能位（可见进度条 / 可重复仪式 / 合法亲密借口 / 公开关系地图 / 元叙事安全阀） */
  functionPositions?: string[]
  /** 为什么好看（≤60 字） */
  whyItWorks?: string
  /** 与已填线索的冲突或风险 */
  risks?: string[]
  scores?: SeedSuggestionScore
  findings?: SeedSuggestionFinding[]
}

export interface PlanEvalSummary {
  score: number
  blocking: number
  warnings: number
  metrics: {
    clicheHits: number
    abstractPct: number
    concretePct: number
    functionPositionCoverage: number
    sceneCount: number
    axisDiversity: number
    avgChars: number
  }
  findings: SeedSuggestionFinding[]
}

/** 整份方案体检：只看多条内容之间的关系，不重复单条批评 */
export interface PlanCritiqueMetrics {
  blockCount: number
  /** 有角色做出选择的块占比 */
  decisionDensity: number
  /** 不同落点类型的数量 */
  endingVariety: number
  /** 跨块重复短语数量 */
  repeatedPhraseCount: number
  avgChars: number
}

export interface PlanCritiqueResult {
  score: number
  findings: SeedSuggestionFinding[]
  metrics: PlanCritiqueMetrics
}

/** 单块 AI 规划提案：建议是可直接填入该字段的完整文本 */
export interface SeedAssistProposal {
  field: SeedAssistField
  /** 与 items 对齐的纯文本，兼容旧 UI 与旧提案 */
  suggestions: string[]
  /** 结构化建议（新）；缺失时由 suggestions 回填 */
  items?: SeedSuggestion[]
  /** 为什么这样建议（一两句） */
  reason?: string
  warnings: string[]
  /** 规划层体检结果 */
  planEval?: PlanEvalSummary
  /** 整份方案体检：多条候选之间的同质化与决策密度 */
  planCritique?: PlanCritiqueResult
  /** 同一块上一批建议的体检分，用于观察是否在变好 */
  previousScore?: number
  /** 是否触发过模板化自动重写 */
  rewritten?: boolean
  /** 是否按作者样例的节奏二次改过句（只改措辞，不改事实） */
  humanized?: boolean
}

export interface ProposedCharacter {
  name: string
  role: 'protagonist' | 'antagonist' | 'supporting'
  profile: string
}

/** AI 补全提案：缺失维度由 AI 建议，全部可改 */
export interface OutlineSeedProposal {
  /** 书名备选；用户已给书名时只含该书名 */
  titles: string[]
  genre: string
  premise: string
  characters: ProposedCharacter[]
  /** A1 契约扩展字段：向导可选择展示或忽略 */
  synopsis?: string
  coreConflict?: string
  tone?: string
  audience?: string
  worldAnchors?: string[]
  sellingPoints?: string[]
  warnings?: string[]
}

/** 用户确认后的立项信息（向导后续步骤与落库的唯一依据） */
export interface ConfirmedSeed {
  title: string
  genre: string
  premise: string
  characters: ProposedCharacter[]
  volumeCount: number
  chapterCount?: number
  /** 作者手写的角色笔记（未落库时也要让后续生成看到） */
  characterNotes?: string
  /** 世界设定/铁律 */
  worldview?: string
  /** 基调与目标读者 */
  tone?: string
  /** 以下为逐块线索，主线和卷章纲生成时一并参考 */
  coreConflict?: string
  protagonist?: string
  setting?: string
  power?: string
  sellingPoints?: string
  references?: string
  taboos?: string
  /** 作者草稿区原文 */
  draft?: string
}

/** 全书主线 + 分卷规划（写作前的前瞻性大纲，非正文总结） */
export interface MasterPlan {
  /** 主线全文（Markdown 纯文本） */
  masterOutline: string
  volumes: {
    title: string
    summary: string
    goal?: string
    climax?: string
    endingHook?: string
    estimatedChapters?: number
    targetWordCount?: number
  }[]
  /** A2 契约扩展：全书期望章数 */
  targetChapters?: number
}

/** 章纲骨架：章名 + 一句话骨架（临写时再细化 hooks） */
export interface ChapterSkeleton {
  title: string
  hooks: string[]
  /** A3 契约扩展字段 */
  conflict?: string
  turn?: string
  payoff?: string
  /** 章末类型：动作/台词/画面/信息/未完成动作/误会 */
  endingType?: string
  targetWordCount?: number
}

/** 重订走向：单章新旧走向对照（只允许指向未写章） */
export interface RecalibrateDiffItem {
  chapterId: string
  volumeId: string
  volumeOrder: number
  chapterOrder: number
  chapterTitle: string
  oldHooks: string[]
  newHooks: string[]
  reason: string
  /** A6 契约扩展：对前后章/伏笔/角色的连带影响 */
  rippleEffects?: string[]
}

/** 重订走向校准结果 */
export interface RecalibrateDiff {
  summary: string
  items: RecalibrateDiffItem[]
  /** LLM 返回但指向已写章/未知章、被红线拦截的数量 */
  skipped: number
}

/** A4 章细纲提案（只允许指向未写章） */
export interface ChapterDetailProposal {
  summary: string
  hooks: string[]
  targetWordCount: number
  /** 承接上一章 / 为下一章留口的说明（契约要求返回数组，可为空） */
  continuityNotes: string[]
  warnings?: string[]
}

export type OutlineIssueSeverity = 'blocking' | 'warning' | 'info'

export type OutlineIssueType =
  | 'pacing'
  | 'logic'
  | 'motivation'
  | 'repetition'
  | 'setup-payoff'
  | 'hook-density'
  | 'volume-escalation'
  | 'chapter-closure'
  | 'serial-unit'
  | 'relationship-state'

/** A5 体检问题；patch 只能指向未写章 */
export interface OutlineReviewIssue {
  id: string
  severity: OutlineIssueSeverity
  type: OutlineIssueType
  volumeOrder?: number
  chapterOrder?: number
  chapterId?: string
  title: string
  description: string
  suggestion: string
  patch?: { summary?: string; hooks?: string[] }
}

/** A5 大纲体检结果 */
export interface OutlineReview {
  score: number
  issues: OutlineReviewIssue[]
  summary: string
  /** 确定性体检脚本发现项，不依赖模型 */
  deterministic?: { severity: OutlineIssueSeverity; type: string; location: string; message: string }[]
  /** 因指向已写章而丢弃的补丁数 */
  skipped?: number
  warnings?: string[]
}
