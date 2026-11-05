// P4：平台数据与发布计划的共享类型

// ===== 平台数据 =====

export interface DailyMetric {
  id: string
  novelId: string
  platform: string
  date: string
  reads: number
  /** 读完率，0~100 */
  completionRate: number
  comments: number
  revenue: number
  createdAt: string
  updatedAt: string
}

export interface DailyMetricInput {
  date: string
  reads: number
  completionRate: number
  comments: number
  revenue: number
}

export interface ChapterMetric {
  id: string
  novelId: string
  platform: string
  date: string
  chapterId: string | null
  platformChapterName: string
  platformOrder: number
  reads: number
  completionRate: number
  comments: number
  revenue: number
  createdAt: string
  updatedAt: string
}

export interface ChapterMetricInput {
  date?: string
  platformChapterName: string
  platformOrder?: number
  reads: number
  completionRate: number
  comments: number
  revenue: number
}

export interface ChapterMapping {
  novelId: string
  platform: string
  platformChapterName: string
  platformOrder: number
  chapterId: string
  updatedAt: string
}

export interface UnmappedChapter {
  platformChapterName: string
  platformOrder: number
}

export interface PlatformComment {
  id: string
  novelId: string
  platform: string
  date: string
  chapterId: string | null
  platformChapterName: string
  content: string
  /** -1 ~ 1，负向为负 */
  sentiment: number
  createdAt: string
}

export interface CommentInput {
  date: string
  chapterId?: string | null
  platformChapterName?: string
  content: string
}

export interface ImportResult {
  imported: number
  updated: number
  errors: string[]
  unmapped: UnmappedChapter[]
}

export interface TrendPoint {
  date: string
  reads: number
  completionRate: number
  comments: number
  revenue: number
}

export interface TrendAnalysis {
  points: TrendPoint[]
  /** 读数变化方向：后 3 天均值 vs 前 3 天均值 */
  direction: 'up' | 'down' | 'flat'
  readsDelta: number
  completionDelta: number
  commentDelta: number
  revenueDelta: number
  /** 一句话概括，不含因果结论 */
  summary: string
}

export interface ChapterAnomaly {
  chapterId: string | null
  chapterTitle: string
  platformChapterName: string
  platformOrder: number
  reads: number
  completionRate: number
  /** 同期可比章节的中位读完率 */
  baseline: number
  /** baseline - completionRate，正数表示下降 */
  drop: number
  isHookChapter: boolean
  wordCount: number
  /** 给作者的“可能原因”，不是因果结论 */
  possibleCauses: string[]
}

export interface SentimentSummary {
  total: number
  positive: number
  negative: number
  neutral: number
  /** -1 ~ 1 */
  average: number
  samples: { content: string; sentiment: number }[]
}

export interface HookComparison {
  hookCount: number
  normalCount: number
  hookAvg: number
  normalAvg: number
  note: string
}

export interface PlatformAnalysis {
  platform: string
  days: number
  trend: TrendAnalysis
  anomalies: ChapterAnomaly[]
  sentiment: SentimentSummary
  hookComparison: HookComparison
  unmapped: UnmappedChapter[]
  dailyCount: number
  chapterCount: number
  commentCount: number
}

// ===== 发布计划 =====

export type PublishPlanStatus = 'planned' | 'published' | 'skipped'

export interface PublishPlan {
  id: string
  novelId: string
  chapterId: string
  plannedDate: string
  status: PublishPlanStatus
  note: string
  createdAt: string
  updatedAt: string
}

export interface PublishChapter {
  chapterId: string
  title: string
  /** 全书全局序号，从 1 开始 */
  order: number
  wordCount: number
  status: string
  hooks: string[]
}

export interface PublishOverview {
  publishedChapter: number
  totalChapters: number
  backlogChapters: number
  backlogWords: number
  stock: PublishChapter[]
  upcoming: PublishChapter[]
  plans: PublishPlan[]
}

// ===== 系列书 =====

export interface SeriesBook {
  id: string
  title: string
  seriesName: string
  seriesOrder: number
  chapterCount: number
  wordCount: number
  updatedAt: string
}

export interface SeriesGroup {
  name: string
  books: SeriesBook[]
  chapterCount: number
  wordCount: number
}