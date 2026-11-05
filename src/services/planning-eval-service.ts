// 规划层评测记录：只追加，不复用，用于观察提示词与锚点是否真的降低了模板化。
import type { PlanEvalSummary, SeedFindingSeverity } from '@shared/types'

const api = () => window.electronAPI

export interface PlanEvalRunInput {
  novelId: string
  stage: 'seed' | 'seed-assist'
  field?: string
  baseRevision?: string
  summary: PlanEvalSummary
  model?: string
}

export interface PlanEvalRun {
  id: string
  novelId: string
  stage: string
  field: string
  baseRevision: string
  score: number
  blocking: number
  warnings: number
  metrics: Record<string, number>
  findings: { code: string; message: string; severity: SeedFindingSeverity }[]
  model: string
  createdAt: string
}

function newId(): string {
  return `per_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function savePlanEvalRun(input: PlanEvalRunInput): Promise<void> {
  try {
    await api()?.db.query(
      'INSERT INTO plan_eval_runs (id, novel_id, stage, field, base_revision, score, blocking, warnings, metrics_json, findings_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        newId(),
        input.novelId,
        input.stage,
        input.field ?? '',
        input.baseRevision ?? '',
        input.summary.score,
        input.summary.blocking,
        input.summary.warnings,
        JSON.stringify(input.summary.metrics),
        JSON.stringify(input.summary.findings),
        input.model ?? '',
        new Date().toISOString(),
      ],
    )
  } catch (e) {
    console.warn('[planning-eval] save failed:', e)
  }
}

export async function listPlanEvalRuns(novelId: string, limit = 20): Promise<PlanEvalRun[]> {
  try {
    const rows = (await api()?.db.query(
      'SELECT * FROM plan_eval_runs WHERE novel_id = ? ORDER BY created_at DESC LIMIT ?',
      [novelId, limit],
    )) as any[] | undefined
    return (rows ?? []).map((row) => ({
      id: row.id,
      novelId: row.novel_id,
      stage: row.stage,
      field: row.field ?? '',
      baseRevision: row.base_revision ?? '',
      score: row.score ?? 0,
      blocking: row.blocking ?? 0,
      warnings: row.warnings ?? 0,
      metrics: parseJson<Record<string, number>>(row.metrics_json, {}),
      findings: parseJson<PlanEvalRun['findings']>(row.findings_json, []),
      model: row.model ?? '',
      createdAt: row.created_at,
    }))
  } catch (e) {
    console.warn('[planning-eval] list failed:', e)
    return []
  }
}
