// P2 文风学习与多书融合：共享类型（渲染层与主进程共用）
// 设计来源：docs/写作系统统一规划-上下文-工具与文风-v2-20261103.md §10

export type StyleSourceKind = 'single_file' | 'chapter_dir' | 'paste' | 'deconstruct'
export type StyleSourceStatus = 'imported' | 'analyzing' | 'ready' | 'failed'
export type StyleProfileStatus = 'draft' | 'ready' | 'stale' | 'failed'
export type StyleDimensionKey =
  | 'pov_tense'
  | 'syntax'
  | 'lexicon'
  | 'dialogue'
  | 'description'
  | 'interiority'
  | 'humor_tone'
  | 'characterization'
  | 'pacing_hooks'
  // 叙事工程层（2.0）：只学“怎么设计”，不学具体设定/人物/情节
  | 'chapter_engineering'
  | 'hook_design'
  | 'relationship_engine'
  | 'setting_function'
  | 'meta_humor'
  | 'concreteness'
  | 'taboo_boundary'
  | 'character_voice'
export type StyleAnchorKind =
  | 'dialogue'
  | 'action'
  | 'description'
  | 'interior'
  | 'transition'
  | 'chapter_end'
  | 'other'
export type StyleAnchorMode = 'excerpt' | 'paraphrase' | 'abstract'
export type StylePov = 'first' | 'third_limited' | 'third_omniscient' | 'mixed' | 'unknown'
export type StyleTense = 'past' | 'present' | 'mixed' | 'unknown'
export type StyleRuleTier = 'must' | 'should'

// ===== 导入语料 =====

export interface CorpusChapter {
  index: number
  title: string
  /** 相对内容根目录的路径：content/styles/<sourceId>/chapters/0001.txt */
  path: string
  charCount: number
  hash: string
  lowValue: boolean
}

export interface CorpusPreview {
  kind: StyleSourceKind
  originPath: string
  encoding: string
  splitMode: 'chapter_markers' | 'analysis_blocks' | 'directory' | 'single'
  chapters: CorpusChapter[]
  skippedFiles: string[]
  duplicateChapters: number
  lowValueChapters: number
  totalChars: number
  contentHash: string
  warnings: string[]
}

export interface CorpusManifest extends CorpusPreview {
  sourceId: string
  name: string
  importedAt: string
}

export interface StyleSource {
  id: string
  name: string
  kind: StyleSourceKind
  originPath: string
  chapterCount: number
  charCount: number
  contentHash: string
  manifestPath: string
  status: StyleSourceStatus
  createdAt: string
  updatedAt: string
}

// ===== 画像 =====

/** 数值轴：全部为可比较的标量，供多书加权融合与生成后 adherence 评分。 */
export interface StyleAxes {
  sentenceAvgLen: number
  shortSentencePct: number
  longSentencePct: number
  paragraphAvgLen: number
  dialoguePct: number
  dialogueAvgLen: number
  shortReplyPct: number
  simileStrictPer1k: number
  dashPerChapter: number
  interiorityPct: number
  sensoryPer1k: number
  colloquialPct: number
  hookEndingPct: number
  infoHookPer1k: number
  chapterAvgLen: number

  // 节奏指纹（2.0）
  ellipsisPerChapter: number
  questionPerChapter: number
  exclaimPerChapter: number
  shortParagraphPct: number
  parentheticalPerChapter: number

  // 章节工程（2.0）
  openingDialoguePct: number
  openingContinuationPct: number
  openingInMediaResPct: number
  endingMedianLen: number
  endingShortImagePct: number
  titleNamePct: number
  titleExclaimPct: number
  titleQuestionPct: number
  titleMultiPartPct: number

  // 具体度与引擎（2.0）
  concreteObjectPer1k: number
  explanationPer1k: number
  publicEventPerChapter: number
  resetPerVolume: number

  // 禁忌与声音（2.0）
  tabooRatio: number
  characterVoiceDispersion: number
}

export interface StyleCategorical {
  pov: StylePov
  tense: StyleTense
  tone: string
  register: string
}

export interface StyleDimension {
  key: StyleDimensionKey
  /** 人读结论（≤80 字） */
  value: string
  confidence: number
  /** ≤60 字原文证据 */
  evidence: string[]
  /** 融合时的变体（非主结论） */
  variants?: string[]
}

export interface StyleRule {
  text: string
  confidence: number
  evidence?: string
  tier?: StyleRuleTier
}

export interface StyleLexicon {
  preferred: string[]
  avoid: string[]
}

export interface StyleSampleStats {
  totalChapters: number
  sampledChapters: number
  sampledChars: number
  model: string
  promptVersion: string
}

// ===== 叙事工程层（Craft Layer，2.0） =====

/** 五个通用功能位：设定在故事里干什么活，而不是设定本身是什么。 */
export const STYLE_FUNCTION_POSITION_KEYS = [
  'visible_progress_bar',
  'repeatable_ritual',
  'intimate_excuse',
  'public_relationship_map',
  'meta_safety_valve',
] as const
export type StyleFunctionPositionKey = (typeof STYLE_FUNCTION_POSITION_KEYS)[number]

export const STYLE_FUNCTION_POSITION_LABEL: Record<StyleFunctionPositionKey, string> = {
  visible_progress_bar: '可见进度条',
  repeatable_ritual: '可重复仪式',
  intimate_excuse: '合法亲密借口',
  public_relationship_map: '公开关系地图',
  meta_safety_valve: '元叙事安全阀',
}

export interface StyleFunctionPosition {
  key: StyleFunctionPositionKey
  /** 这个功能位在故事里干什么活（≤80 字） */
  description: string
  /** 原书证据，≤60 字/条 */
  evidence: string[]
  /** 是否可迁移到新书 */
  transferable: boolean
  /** 对原设定的依赖程度；越低越容易换线不换针 */
  settingDependency: 'low' | 'medium' | 'high'
}

/** 可重复场景：只存抽象场景/物件，不存原书专有地点名。 */
export interface StyleSceneBankItem {
  scene: string
  function: string
  /** 原书出现章数 */
  frequency: number
  transferable: boolean
}

/** 角色声音指纹：按功能位存，不存原书真名。 */
export interface StyleVoiceProfile {
  characterRole: string
  sentenceAvgLen: number
  ellipsisPerChapter: number
  questionPerChapter: number
  exclaimPerChapter: number
  verbalTics: string[]
  tabooPhrases: string[]
  evidence: string[]
}

/** 作者实际 vs AI 默认的差异对照组。 */
export interface StyleCraftComparison {
  dimension: string
  author: string
  aiDefault: string
  rule: string
}

export interface StyleCraftData {
  functionPositions: StyleFunctionPosition[]
  sceneBank: StyleSceneBankItem[]
  voices: StyleVoiceProfile[]
  taboos: string[]
  chapterEngineering: {
    openingPatterns: string[]
    endingPatterns: string[]
    titlePatterns: string[]
  }
  relationshipEngine: string[]
  plotEngine: string[]
  comparison: StyleCraftComparison[]
}

export interface StyleProfileData {
  schemaVersion: '1.0' | '2.0'
  metricVersion: string
  summary: string
  axes: StyleAxes
  categorical: StyleCategorical
  dimensions: StyleDimension[]
  rules: { do: StyleRule[]; dont: StyleRule[] }
  lexicon: StyleLexicon
  sourceEntities: string[]
  sampleStats: StyleSampleStats
  confidence: number
  /** 2.0：叙事工程层；旧画像没有该字段 */
  craft?: StyleCraftData
}

export interface StyleProfile {
  id: string
  sourceId: string
  version: number
  status: StyleProfileStatus
  confidence: number
  model: string
  promptVersion: string
  contentHash: string
  payload: StyleProfileData
  metrics: Record<string, unknown>
  sampleStats: StyleSampleStats
  createdAt: string
  updatedAt: string
}

export interface StyleAnchor {
  id: string
  profileId: string
  kind: StyleAnchorKind
  text: string
  charCount: number
  chapterIndex: number
  quality: number
  origin: 'excerpt' | 'llm'
  createdAt: string
}

// ===== 配方与绑定 =====

export interface StyleRecipeItem {
  sourceId: string
  profileId: string
  weight: number
}

export type StyleDimensionWeights = Partial<Record<StyleDimensionKey, Record<string, number>>>

export interface StyleRecipe {
  id: string
  name: string
  /** 0~100；0 等价未绑定 */
  strength: number
  povPolicy: 'follow_novel' | 'follow_recipe'
  povOverride?: StylePov | null
  anchorMode: StyleAnchorMode
  /** 锚点总字数预算 */
  anchorBudget: number
  items: StyleRecipeItem[]
  dimensionWeights: StyleDimensionWeights
  extraRules: string[]
  overridesJson: Record<string, unknown>
  status: 'draft' | 'ready'
  createdAt: string
  updatedAt: string
}

export interface NovelStyleBinding {
  novelId: string
  recipeId: string
  enabled: boolean
  strengthOverride?: number | null
  updatedAt: string
}

// ===== 融合结果 =====

export interface StyleConflict {
  kind: 'pov' | 'tense' | 'rule' | 'categorical'
  message: string
  values: { sourceId: string; name: string; value: string }[]
}

export interface MergedStyleProfile {
  recipeId: string
  recipeName: string
  strength: number
  anchorMode: StyleAnchorMode
  sourceNames: string[]
  summary: string
  axes: StyleAxes
  categorical: StyleCategorical
  dimensions: StyleDimension[]
  rules: { do: StyleRule[]; dont: StyleRule[] }
  lexicon: StyleLexicon
  sourceEntities: string[]
  anchors: StyleAnchor[]
  /** 作者手写规则，置顶且不降权 */
  extraRules: string[]
  conflicts: StyleConflict[]
  confidence: number
  /** 2.0：融合后的叙事工程层 */
  craft?: StyleCraftData
  /** 参与融合的画像（诊断用） */
  mergedFrom: { sourceId: string; name: string; profileId: string; weight: number; confidence: number }[]
}

// ===== 评估 =====

export interface StyleEvalDimension {
  key: string
  label: string
  actual: number
  target: number
  tolerance: number
  adherence: number
  weight: number
}

/** 叙事工程层的分项得分（表达像/结构像/角色像/钩子像/禁忌像）。 */
export interface CraftEvalDimension {
  key: string
  label: string
  score: number
  detail?: string
}

export interface StyleEvalFinding {
  dimension: string
  severity: 'advisory' | 'blocking'
  message: string
}

export interface SimilarityHit {
  kind: 'ngram' | 'lcs' | 'entity'
  value: string
  severity: 'advisory' | 'blocking'
  detail: string
}

export interface SimilarityReport {
  ngramRate: number
  longestCommon: number
  hits: SimilarityHit[]
  blocking: number
  advisory: number
}

export interface StyleEvalResult {
  styleScore: number
  metricsScore: number
  rubricScore?: number | null
  dimensions: StyleEvalDimension[]
  findings: StyleEvalFinding[]
  similarity: SimilarityReport
  /** 2.0：表达层 + 叙事工程层的综合“像不像你”得分 */
  overallScore?: number
  /** 2.0：叙事工程层得分；旧记录没有 */
  craftScore?: number
  craftDimensions?: CraftEvalDimension[]
  craftFindings?: StyleEvalFinding[]
  /** 评估使用的配方强度与目标来源 */
  recipeId: string
  recipeName: string
  createdAt: string
}

export interface StyleEvalRun extends StyleEvalResult {
  id: string
  novelId: string
  chapterId: string
  chapterHash: string
  model: string
}
