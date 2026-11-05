// P1.5：改稿与级联修订的共享类型。
// diff 只做到段/行级，避免字符级噪音；任务落 content/revisions/<novelId>/tasks.json。

export type DiffKind = 'equal' | 'added' | 'removed'

export interface DiffSegment {
  /** 稳定 key，用于界面记录“采用/撤回”状态 */
  key: string
  kind: DiffKind
  lines: string[]
  oldStart: number
  newStart: number
}

export interface DiffSummary {
  added: number
  removed: number
  unchanged: number
}

export interface DiffResult {
  segments: DiffSegment[]
  summary: DiffSummary
}

export type ImpactEntityKind = 'character' | 'item' | 'ability' | 'location' | 'keyword'

export interface ImpactEntity {
  name: string
  kind: ImpactEntityKind
}

export interface ImpactHit {
  chapterId: string
  chapterTitle: string
  chapterOrder: number
  volumeId: string
  volumeTitle: string
  entity: string
  reason: string
  sentence: string
}

export interface ImpactReport {
  entities: ImpactEntity[]
  hits: ImpactHit[]
  scannedChapters: number
}

export type RevisionTaskType = 'continuity' | 'outline' | 'polish' | 'rewrite'
export type RevisionTaskStatus = 'open' | 'done' | 'ignored'

export interface RevisionTask {
  id: string
  sourceChapterId: string
  targetChapterId: string
  type: RevisionTaskType
  description: string
  status: RevisionTaskStatus
  createdAt: string
  resolvedAt?: string
}

export interface RevisionTaskInput {
  novelId: string
  sourceChapterId: string
  targetChapterId: string
  type: RevisionTaskType
  description: string
}

export type CascadeSeverity = 'blocking' | 'warning'

export interface CascadeFinding {
  ruleId: string
  severity: CascadeSeverity
  message: string
  location?: string
  suggestion?: string
  evidence?: string
}

export interface CascadeChapterResult {
  chapterId: string
  chapterTitle: string
  chapterOrder: number
  findings: CascadeFinding[]
}

export interface CascadeReport {
  chapters: CascadeChapterResult[]
  scannedChapters: number
  blocking: number
  warnings: number
}

export const REVISION_TASK_TYPE_LABEL: Record<RevisionTaskType, string> = {
  continuity: '事实冲突',
  outline: '大纲变更',
  polish: '润色',
  rewrite: '重写',
}

export const REVISION_TASK_STATUS_LABEL: Record<RevisionTaskStatus, string> = {
  open: '待处理',
  done: '已确认',
  ignored: '已忽略',
}
