// P3 评估与读者反馈：共享类型（渲染层与主进程共用）
// 设计来源：docs/写作系统统一规划-上下文-工具与文风-v2-20261103.md §11

export type EvalLayer = 'deterministic' | 'model' | 'human'
export type EvalSeverity = 'blocking' | 'warning' | 'advisory'

// ===== 三层评估 =====

export interface EvalFinding {
  layer: EvalLayer
  ruleId: string
  label: string
  severity: EvalSeverity
  message: string
  suggestion?: string
  location?: string
  evidence?: string
}

export interface DeterministicEvalResult {
  score: number
  blocking: number
  warnings: number
  wordCount: number
  targetWordCount: number
  chapterEndHook: boolean
  qualityScore: number
  findings: EvalFinding[]
}

export interface ModelEvalResult {
  /** 是否请求过模型（用户勾选） */
  attempted: boolean
  /** 模型实际是否可用（无 Agent / 调用失败时为 false） */
  available: boolean
  styleScore: number | null
  semanticScore: number | null
  voiceScore: number | null
  findings: EvalFinding[]
  suggestions: string[]
  notes: string
}

export interface ChapterEvalResult {
  overallScore: number
  deterministicScore: number
  modelScore: number | null
  styleScore: number | null
  deterministic: DeterministicEvalResult
  model: ModelEvalResult
  suggestions: string[]
  createdAt: string
}

export interface ChapterEvalRun extends ChapterEvalResult {
  id: string
  novelId: string
  chapterId: string
  chapterHash: string
  modelName: string
}

// ===== 读者模拟 =====

export type ReaderGenderOrientation = 'male' | 'female' | 'general' | 'unspecified'

export interface ReaderProfile {
  genre: string
  platform: string
  genderOrientation: ReaderGenderOrientation
  note: string
}

export interface ReaderPayoff {
  expectation: string
  status: 'paid' | 'partial' | 'unpaid'
  note: string
}

export interface ReaderDropOff {
  location: string
  reason: string
  suggestion: string
}

export interface ReaderSimResult {
  /** 固定为 true：所有结论都是模拟，不是真实读者数据 */
  simulated: true
  modelAssisted: boolean
  questions: string[]
  payoffs: ReaderPayoff[]
  dropOffs: ReaderDropOff[]
  hookStrength: number
  infoDensity: number
  /** 五段情绪强度（0~100） */
  emotionCurve: number[]
  suggestions: string[]
  notes: string
  chapterCount: number
  createdAt: string
}

export interface ReaderSimRun extends ReaderSimResult {
  id: string
  novelId: string
  chapterIds: string[]
  profile: ReaderProfile
  model: string
}

// ===== 人工层反馈 =====

export type FeedbackVerdict = 'accepted' | 'rejected' | 'note'

export interface ChapterFeedbackNote {
  id: string
  novelId: string
  chapterId: string
  evalRunId: string | null
  verdict: FeedbackVerdict
  comment: string
  createdAt: string
}

export const DEFAULT_READER_PROFILE: ReaderProfile = {
  genre: '',
  platform: '',
  genderOrientation: 'unspecified',
  note: '',
}
