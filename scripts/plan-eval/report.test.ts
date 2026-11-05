import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLAN_EVAL_ARMS,
  PLAN_EVAL_TASKS,
  buildEvalArmBundle,
  renderEvalReport,
  scoreEvalCell,
  summarizeEval,
  type PlanEvalCell,
  type PlanEvalOutputBlock,
  type PlanEvalOutputs,
} from '@/services/planning-eval-harness'
import type { PlanningStyleContext } from '@/services/planning-style-service'
import { FIXTURE_OUTPUTS } from './fixtures'

const STYLE_CTX: PlanningStyleContext = {
  sourceNames: ['旧作样本'],
  strength: 60,
  craftCard: '',
  anchors: ['［chapter_end］她把伞塞给他，转身跑进雨里。', '［dialogue］“这句也要读吗？”'],
}

const OUTPUTS_PATH = path.join(process.cwd(), 'scripts/plan-eval/outputs.json')
const REPORT_DIR = path.join(process.cwd(), 'scripts/plan-eval')

function loadOutputs(): { outputs: PlanEvalOutputs; fixture: boolean } {
  if (fs.existsSync(OUTPUTS_PATH)) {
    return { outputs: JSON.parse(fs.readFileSync(OUTPUTS_PATH, 'utf8')) as PlanEvalOutputs, fixture: false }
  }
  return { outputs: FIXTURE_OUTPUTS, fixture: true }
}

describe('planning-eval-harness · 固定评估集', () => {
  it('固定 10 个任务，覆盖立项、主线、卷章纲与章细纲', () => {
    expect(PLAN_EVAL_TASKS).toHaveLength(10)
    expect(new Set(PLAN_EVAL_TASKS.map((task) => task.stage))).toEqual(
      new Set(['seed', 'master', 'volume-chapters', 'chapter-detail']),
    )
    expect(new Set(PLAN_EVAL_TASKS.map((task) => task.id)).size).toBe(10)
  })

  it('三臂只改变参考注入与作者锚点', () => {
    for (const task of PLAN_EVAL_TASKS) {
      const baseline = buildEvalArmBundle(task, 'baseline')
      const prose = buildEvalArmBundle(task, 'prose-anchors', STYLE_CTX)
      const planning = buildEvalArmBundle(task, 'planning-samples')

      expect(baseline.bundle.referenceText).not.toContain('/references/anti-ai-planning.md')
      expect(baseline.bundle.referenceText).not.toContain('/references/sample-')
      expect(planning.bundle.referenceText).toContain('/references/anti-ai-planning.md')
      if (['seed', 'volume-chapters', 'chapter-detail'].includes(task.stage)) {
        expect(planning.bundle.referenceText).toContain('/references/sample-')
      }

      expect(baseline.bundle.taskPrompt).not.toContain('作者原作的场面锚点')
      expect(prose.bundle.taskPrompt).toContain('作者原作的场面锚点')
      expect(planning.bundle.taskPrompt).not.toContain('作者原作的场面锚点')

      expect(baseline.bundle.contractText).toBe(planning.bundle.contractText)
      expect(baseline.references.length).toBeLessThan(planning.references.length)
    }
  })

  it('样例评分方向正确：规划样本臂优于基线', () => {
    const { outputs } = loadOutputs()
    const cells: PlanEvalCell[] = []
    for (const task of PLAN_EVAL_TASKS) {
      for (const arm of PLAN_EVAL_ARMS) {
        const blocks = outputs[task.id]?.[arm]
        if (blocks?.length) cells.push(scoreEvalCell(task, arm, blocks))
      }
    }
    const summary = summarizeEval(cells)
    const baseline = summary.find((row) => row.arm === 'baseline')!
    const planning = summary.find((row) => row.arm === 'planning-samples')!
    expect(baseline.count).toBeGreaterThan(0)
    expect(planning.avgPlanScore).toBeGreaterThan(baseline.avgPlanScore)
    expect(planning.avgBlockBlocking).toBeLessThanOrEqual(baseline.avgBlockBlocking)
  })

  it('生成 report.json 与 report.md', () => {
    const { outputs, fixture } = loadOutputs()
    const cells: PlanEvalCell[] = []
    const taskIds: string[] = []
    for (const task of PLAN_EVAL_TASKS) {
      let scored = false
      for (const arm of PLAN_EVAL_ARMS) {
        const blocks: PlanEvalOutputBlock[] | undefined = outputs[task.id]?.[arm]
        if (!blocks?.length) continue
        scored = true
        cells.push(scoreEvalCell(task, arm, blocks))
      }
      if (scored) taskIds.push(task.id)
    }

    const report = renderEvalReport(cells, { fixture, taskIds })
    fs.mkdirSync(REPORT_DIR, { recursive: true })
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), report.json, 'utf8')
    fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), report.markdown, 'utf8')

    expect(JSON.parse(report.json).taskCount).toBe(taskIds.length)
    expect(report.markdown).toContain('盲评表')
  })
})
