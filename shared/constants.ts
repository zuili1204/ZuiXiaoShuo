export const APP_NAME = '醉小说'
export const APP_VERSION = '0.1.0'

export const DEFAULT_WORD_COUNT = 3000
export const AUTO_SAVE_DELAY = 3000
export const MAX_BACKUP_COUNT = 3

export const CHAPTER_STATUS_OPTIONS = [
  { value: 'draft', label: '草稿', color: '#6b7280' },
  { value: 'reviewed', label: '已审查', color: '#3b82f6' },
  { value: 'polished', label: '已润色', color: '#8b5cf6' },
  { value: 'final', label: '终稿', color: '#22c55e' },
]

export const NOVEL_STATUS_OPTIONS = [
  { value: 'planning', label: '规划中', color: '#f59e0b' },
  { value: 'writing', label: '连载中', color: '#3b82f6' },
  { value: 'completed', label: '已完结', color: '#22c55e' },
]

export const GENRE_OPTIONS = [
  '玄幻', '仙侠', '都市', '历史', '科幻', '悬疑',
  '言情', '武侠', '游戏', '轻小说', '奇幻', '军事',
  '体育', '二次元', '同人', '现实', '短篇',
]

export const PLATFORM_OPTIONS = ['起点', '番茄', '晋江', '七猫', '其他']

export const LLM_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    endpoint: 'https://api.openai.com/v1',
    customEndpoint: false,
  },
  deepseek: {
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    endpoint: 'https://api.deepseek.com/v1',
    customEndpoint: false,
  },
  anthropic: {
    name: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-3-5'],
    endpoint: 'https://api.anthropic.com',
    customEndpoint: false,
  },
  // 自定义：用户可填任意 base URL 与任意模型名（如接入私有网关或兼容 OpenAI 的服务）
  custom: {
    name: '自定义 / Custom',
    defaultModel: '',
    models: [],
    endpoint: '',
    customEndpoint: true,
  },
  // P2：新增 SiliconFlow（硅基流动）—— 高性价比兼容 OpenAI 协议，适合日更正文
  siliconflow: {
    name: 'SiliconFlow',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    endpoint: 'https://api.siliconflow.cn/v1',
    customEndpoint: false,
  },
  // P2：新增 xAI —— Grok 系列，长上下文与强推理
  xai: {
    name: 'xAI',
    defaultModel: 'grok-2',
    models: ['grok-2', 'grok-2-mini', 'grok-beta'],
    endpoint: 'https://api.x.ai/v1',
    customEndpoint: false,
  },
}

// Provider 展示顺序（UI 胶囊按钮组）
export const PROVIDER_ORDER = ['openai', 'deepseek', 'anthropic', 'siliconflow', 'xai', 'custom'] as const
export type ProviderId = (typeof PROVIDER_ORDER)[number]

// 判断一个 provider 标识是否使用 OpenAI 兼容协议（默认 true；anthropic 例外）
export function isAnthropicProvider(provider: string): boolean {
  return provider === 'anthropic'
}

// 获取某 provider 的接口地址；custom 时返回用户填入的 endpoint
export function resolveEndpoint(provider: string, customEndpoint?: string): string {
  if (provider === 'custom') return customEndpoint || ''
  return LLM_PROVIDERS[provider as keyof typeof LLM_PROVIDERS]?.endpoint || ''
}

export const AGENT_ROLE_LABELS = {
  architect: { name: '审稿者', emoji: '🏗️', description: '结构诊断、节奏分析、钩子设计' },
  writer: { name: '作者', emoji: '✍️', description: '正文写作、对话创作、场景描写' },
  polisher: { name: '润稿者', emoji: '✨', description: '去AI味、文风统一、标点规范' },
  checker: { name: '读者', emoji: '🔍', description: '事实冲突扫描、伏笔检测、一致性校验' },
  // P2：导演式编排扩展的 7 专业角色
  planner: { name: '规划师', emoji: '📋', description: '意图拆解、子任务派发、依赖编排' },
  runtime: { name: '运行时', emoji: '⚙️', description: '调度流水线、检查点读写、断点续跑' },
  director: { name: '导演', emoji: '🎬', description: '全局编排、审批决策、Human-in-the-Loop' },
  consistency: { name: '一致性专员', emoji: '🧩', description: '跨章事实/时间线/设定核查' },
}

export const DEFAULT_AGENT_CONFIGS = [
  {
    role: 'architect' as const,
    name: '审稿者 - Story Architect',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    temperature: 0.3,
    maxTokens: 4096,
    systemPrompt: '你是一位资深的小说架构师，擅长结构诊断、节奏分析和钩子设计。',
    skillRefs: ['story-review'],
  },
  {
    role: 'writer' as const,
    name: '作者 - Narrative Writer',
    provider: 'deepseek',
    model: 'deepseek-chat',
    // IMP-08：0.8 高温是修辞过载（比喻密度 3.09/千字，远超人工基线 0.93）的重要成因；
    // 降到 0.65 抑制"每句都写漂亮"；maxTokens 4096→8192 避免第 5 章截断。
    temperature: 0.65,
    maxTokens: 8192,
    topP: 0.9,
    systemPrompt: '你是一位经验丰富的网络小说作家，擅长情节构建和场景描写。',
    skillRefs: ['story-long-write'],
  },
  {
    role: 'polisher' as const,
    name: '润稿者 - Story Polisher',
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.5,
    maxTokens: 4096,
    systemPrompt: '你是一位专业的小说编辑，擅长去AI味、文风统一和语言润色。',
    skillRefs: ['story-deslop'],
  },
  {
    role: 'checker' as const,
    name: '读者 - Consistency Checker',
    provider: 'anthropic',
    model: 'claude-haiku-3-5',
    temperature: 0.2,
    maxTokens: 2048,
    systemPrompt: '你是一位细心的读者和质检员，擅长发现前后矛盾和伏笔断线。',
    skillRefs: ['story-review/foreshadowing', 'story-review/character'],
  },
  // P2：导演式编排扩展的 4 个专业角色
  {
    role: 'planner' as const,
    name: '规划师 - Task Planner',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    temperature: 0.3,
    maxTokens: 4096,
    systemPrompt: '你是导演的副手「规划师」，负责把作者的一句话意图拆解为可执行的子任务序列，标注依赖与所需技能。',
    skillRefs: ['story-outline-gen', 'story-setup'],
  },
  {
    role: 'runtime' as const,
    name: '运行时 - Pipeline Runtime',
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.4,
    maxTokens: 4096,
    systemPrompt: '你是「运行时调度」，负责按子任务依赖顺序驱动多 Agent 流水线，读写检查点，支持暂停/恢复。',
    skillRefs: [],
  },
  {
    role: 'director' as const,
    name: '导演 - Story Director',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    temperature: 0.3,
    maxTokens: 4096,
    systemPrompt: '你是「导演」，统筹全书创作：拆解意图、派发子任务、在关键节点（大纲定稿/黄金三章/卷末）请求作者审批，绝不替作者一键代写完整书。',
    skillRefs: ['story-setup', 'story-outline-gen', 'story-golden-opening'],
  },
  {
    role: 'consistency' as const,
    name: '一致性专员 - Continuity Editor',
    provider: 'anthropic',
    model: 'claude-haiku-3-5',
    temperature: 0.2,
    maxTokens: 4096,
    systemPrompt: '你是「一致性专员」，跨章核查事实/时间线/人设/伏笔，输出带章节定位的冲突清单，不擅自修改。',
    skillRefs: ['story-consistency', 'story-pacing'],
  },
]
