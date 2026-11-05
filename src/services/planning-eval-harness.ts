import type { SeedAssistField } from '@shared/types'
import type { PlanStage } from './planning-skill-service'
import { buildPlanningPromptBundle, resolvePlanRoute } from './planning-skill-service'
import { critiquePlan, critiqueText } from './planning-critic'
import { planningCraftSection, type PlanningStyleContext } from './planning-style-service'

export type PlanEvalArm = 'baseline' | 'prose-anchors' | 'planning-samples'

export const PLAN_EVAL_ARMS: PlanEvalArm[] = ['baseline', 'prose-anchors', 'planning-samples']

export interface PlanEvalTask {
  id: string
  stage: PlanStage
  label: string
  field: SeedAssistField
  brief: string
  facts: string
}

export interface PlanEvalOutputBlock {
  location: string
  text: string
}

export type PlanEvalOutputs = Record<string, Partial<Record<PlanEvalArm, PlanEvalOutputBlock[]>>>

export interface PlanEvalCell {
  taskId: string
  arm: PlanEvalArm
  blocks: number
  planScore: number
  blockBlocking: number
  blockWarnings: number
  decisionDensity: number
  endingVariety: number
  repeatedPhraseCount: number
  avgChars: number
}

export interface PlanEvalArmSummary {
  arm: PlanEvalArm
  count: number
  avgPlanScore: number
  avgBlockBlocking: number
  avgDecisionDensity: number
  avgEndingVariety: number
  avgRepeatedPhrases: number
}

export interface PlanEvalEvalBundle {
  taskId: string
  arm: PlanEvalArm
  references: string[]
  bundle: ReturnType<typeof buildPlanningPromptBundle>
}

/** 固定评估集：同一批任务、同一份输入，只改提示词注入变量 */
export const PLAN_EVAL_TASKS: PlanEvalTask[] = [
  {
    id: 'eval-seed-campus',
    stage: 'seed',
    label: '校园轻喜剧立项',
    field: 'premise',
    brief: '中式轻小说、日常搞笑、关系推进，不要苦大仇深',
    facts: '固定地点是校门口的旧书摊；主角靠补书赚零花钱；同桌总把撕坏的练习册推过来。',
  },
  {
    id: 'eval-seed-mystery',
    stage: 'seed',
    label: '都市悬疑立项',
    field: 'premise',
    brief: '近未来沿海城市、轻悬疑、强关系线，不要连环凶案',
    facts: '城市监控全覆盖；主角能听见监控盲区里残留的三十秒声音；固定单元是夜间便利店。',
  },
  {
    id: 'eval-seed-fantasy',
    stage: 'seed',
    label: '中式玄幻立项',
    field: 'premise',
    brief: '东方志怪、轻松向、师门日常，不要退婚打脸',
    facts: '妖怪必须遵守人间契约；主角在城隍庙做临时工；能力是替妖怪代写诉状。',
  },
  {
    id: 'eval-master-campus',
    stage: 'master',
    label: '校园主线与分卷',
    field: 'premise',
    brief: '四卷，关系递进优先于敌人升级',
    facts: '主角从偷偷补书到公开摆摊；每卷固定一个校园公共事件。',
  },
  {
    id: 'eval-master-mystery',
    stage: 'master',
    label: '悬疑主线与分卷',
    field: 'premise',
    brief: '三卷，信息揭示递进，不靠新反派续命',
    facts: '每卷揭开一层城市监控的来历；主角与搭档的信任逐卷变化。',
  },
  {
    id: 'eval-volume-campus',
    stage: 'volume-chapters',
    label: '校园卷章纲',
    field: 'premise',
    brief: '首卷 12 章，章型要轮换',
    facts: '本卷目标是让主角接第一单补书生意并暴露手艺。',
  },
  {
    id: 'eval-volume-mystery',
    stage: 'volume-chapters',
    label: '悬疑卷章纲',
    field: 'premise',
    brief: '首卷 10 章，信息章与关系章交替',
    facts: '本卷目标是从一段三十秒录音里找到第一个证人。',
  },
  {
    id: 'eval-volume-ensemble',
    stage: 'volume-chapters',
    label: '群像日常卷章纲',
    field: 'premise',
    brief: '首卷 14 章，群像轮换，避免每章都围着主角',
    facts: '固定场景是旧书摊与校门口的小摊。',
  },
  {
    id: 'eval-chapter-campus',
    stage: 'chapter-detail',
    label: '校园章细纲',
    field: 'premise',
    brief: '承接上一章旧书事件，为下一章公告栏留钩',
    facts: '目标章尚未动笔；本章要暴露补书摊的麻烦。',
  },
  {
    id: 'eval-chapter-mystery',
    stage: 'chapter-detail',
    label: '悬疑章细纲',
    field: 'premise',
    brief: '承接录音线索，为下一章证人出场留钩',
    facts: '目标章尚未动笔；本章要让主角第一次主动说谎。',
  },
]

const EXPERIMENT_REF_MARKERS = ['/references/anti-ai-planning.md', '/references/sample-']

function referencesForArm(stage: PlanStage, arm: PlanEvalArm): string[] {
  const refs = resolvePlanRoute(stage).references
  if (arm === 'planning-samples') return refs
  return refs.filter((ref) => !EXPERIMENT_REF_MARKERS.some((marker) => ref.includes(marker)))
}

export function buildEvalArmTaskPrompt(
  task: PlanEvalTask,
  arm: PlanEvalArm,
  styleCtx?: PlanningStyleContext | null,
): string {
  const lines = [
    '==== 固定评估任务 ====',
    task.label,
    task.facts,
    '',
    `作者方向：${task.brief}`,
    '',
    '本次要求：',
    '- 输出 4~6 个块，每块给出位置与完整文本',
    '- 每块至少有一个角色做出选择，或一个会改变局面的具体动作',
    '- 落点不要停在总结、决心或升华上',
  ]
  if (arm === 'prose-anchors' && styleCtx) {
    lines.push('', planningCraftSection({ ...styleCtx, craftCard: '' }, task.stage))
  }
  return lines.join('\n')
}

export function buildEvalArmBundle(
  task: PlanEvalTask,
  arm: PlanEvalArm,
  styleCtx?: PlanningStyleContext | null,
): PlanEvalEvalBundle {
  const references = referencesForArm(task.stage, arm)
  const bundle = buildPlanningPromptBundle(
    task.stage,
    'standard',
    buildEvalArmTaskPrompt(task, arm, styleCtx),
    '只输出 JSON，不要解释：{"blocks":[{"location":"第1章","text":"..."}]}，blocks 4~6 条。',
    { references },
  )
  return { taskId: task.id, arm, references, bundle }
}

export function scoreEvalCell(
  task: PlanEvalTask,
  arm: PlanEvalArm,
  blocks: PlanEvalOutputBlock[],
): PlanEvalCell {
  const plan = critiquePlan(blocks)
  const critiques = blocks.map((block) => critiqueText(block.text, task.field))
  return {
    taskId: task.id,
    arm,
    blocks: blocks.length,
    planScore: plan.score,
    blockBlocking: critiques.reduce((sum, c) => sum + c.blocking, 0),
    blockWarnings: critiques.reduce((sum, c) => sum + c.warnings, 0),
    decisionDensity: plan.metrics.decisionDensity,
    endingVariety: plan.metrics.endingVariety,
    repeatedPhraseCount: plan.metrics.repeatedPhraseCount,
    avgChars: plan.metrics.avgChars,
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return round(values.reduce((sum, v) => sum + v, 0) / values.length)
}

export function summarizeEval(cells: PlanEvalCell[]): PlanEvalArmSummary[] {
  return PLAN_EVAL_ARMS.map((arm) => {
    const list = cells.filter((cell) => cell.arm === arm)
    return {
      arm,
      count: list.length,
      avgPlanScore: mean(list.map((cell) => cell.planScore)),
      avgBlockBlocking: mean(list.map((cell) => cell.blockBlocking)),
      avgDecisionDensity: mean(list.map((cell) => cell.decisionDensity)),
      avgEndingVariety: mean(list.map((cell) => cell.endingVariety)),
      avgRepeatedPhrases: mean(list.map((cell) => cell.repeatedPhraseCount)),
    }
  })
}

const BLIND_LABELS = ['X', 'Y', 'Z'] as const

export function blindAliases(taskId: string): Record<string, PlanEvalArm> {
  const offset = [...taskId].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PLAN_EVAL_ARMS.length
  const rotated = [...PLAN_EVAL_ARMS.slice(offset), ...PLAN_EVAL_ARMS.slice(0, offset)]
  return Object.fromEntries(BLIND_LABELS.map((label, i) => [label, rotated[i]]))
}

export function renderEvalReport(
  cells: PlanEvalCell[],
  options: { fixture: boolean; taskIds?: string[] },
): { json: string; markdown: string } {
  const taskIds = options.taskIds ?? [...new Set(cells.map((cell) => cell.taskId))]
  const tasks = PLAN_EVAL_TASKS.filter((task) => taskIds.includes(task.id))
  const summary = summarizeEval(cells)
  const baseline = summary.find((row) => row.arm === 'baseline')

  const payload = {
    fixture: options.fixture,
    taskCount: tasks.length,
    armCount: PLAN_EVAL_ARMS.length,
    summary,
    cells,
    blind: tasks.map((task) => ({ taskId: task.id, aliases: blindAliases(task.id) })),
  }

  const summaryRows = summary.map((row) => {
    const delta = baseline && row.arm !== 'baseline' ? round(row.avgPlanScore - baseline.avgPlanScore) : null
    return `| ${row.arm} | ${row.count} | ${row.avgPlanScore} | ${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta}`} | ${row.avgBlockBlocking} | ${row.avgDecisionDensity} | ${row.avgEndingVariety} | ${row.avgRepeatedPhrases} |`
  })

  const detailRows = cells.map(
    (cell) =>
      `| ${cell.taskId} | ${cell.arm} | ${cell.planScore} | ${cell.blockBlocking} | ${cell.decisionDensity} | ${cell.endingVariety} | ${cell.repeatedPhraseCount} | ${cell.avgChars} |`,
  )

  const blindRows = tasks.map((task) => {
    const aliases = blindAliases(task.id)
    return `| ${task.id} | ${aliases.X} | ${aliases.Y} | ${aliases.Z} |  |  |  |`
  })

  const markdown = [
    '# 规划 A/B 评估报告',
    '',
    options.fixture
      ? '> 当前报告使用仓库内样例输出，只用于验证评估管线与指标方向，不代表真实模型效果。'
      : '> 当前报告使用真实生成输出。',
    `> 覆盖 ${tasks.length}/${PLAN_EVAL_TASKS.length} 个固定任务；未提供输出的任务不进入汇总。`,
    '',
    '## 三臂说明',
    '',
    '- baseline：只保留阶段方法论参考，不注入反模板准则、规划样本与作者锚点。',
    '- prose-anchors：在 baseline 上追加作者原作的场面锚点（每次只改变这一个变量）。',
    '- planning-samples：注入反模板准则与阶段匹配的规划样本，不追加作者锚点。',
    '',
    '## 汇总',
    '',
    '| 臂 | 样本数 | 平均分 | 相对基线 | 单块阻断 | 决策密度 | 落点种类 | 重复短语 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaryRows,
    '',
    '## 明细',
    '',
    '| 任务 | 臂 | 分 | 单块阻断 | 决策密度 | 落点种类 | 重复短语 | 平均字数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...detailRows,
    '',
    '## 盲评表（人工填写 1-5 分）',
    '',
    '先看三份输出文本再打分；版本与臂的对应关系只保存在 report.json 的 blind 字段。',
    '',
    '| 任务 | 版本X | 版本Y | 版本Z | 分数X | 分数Y | 分数Z |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...blindRows,
    '',
  ].join('\n')

  return { json: `${JSON.stringify(payload, null, 2)}\n`, markdown }
}
