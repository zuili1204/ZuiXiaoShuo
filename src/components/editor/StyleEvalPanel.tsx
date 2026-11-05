import { useCallback, useEffect, useState } from 'react'
import { Gauge, Loader2, RefreshCw, AlertTriangle, Info, Sparkles } from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import { evaluateAndSave } from '@/services/style-eval-service'
import { listStyleEvalRuns } from '@/services/style-service'
import type { StyleEvalRun } from '@shared/style-types'
import { cn } from '@/utils/cn'

function scoreLevel(score: number): { text: string; color: string } {
  if (score >= 80) return { text: '像你', color: 'text-emerald-400' }
  if (score >= 60) return { text: '基本像你', color: 'text-yellow-400' }
  if (score >= 40) return { text: '有可见漂移', color: 'text-orange-400' }
  return { text: '不太像你', color: 'text-red-400' }
}

function overallOf(run: StyleEvalRun): number {
  return run.overallScore ?? run.styleScore
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function StyleEvalPanel({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const content = useWorkbenchStore((s) => s.editorContent)
  const [runs, setRuns] = useState<StyleEvalRun[]>([])
  const [report, setReport] = useState<StyleEvalRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    if (!selectedChapter) {
      setRuns([])
      setReport(null)
      return
    }
    const rows = await listStyleEvalRuns(selectedChapter.id, 10)
    setRuns(rows)
    setReport(rows[0] ?? null)
  }, [selectedChapter])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  const evaluate = async () => {
    if (!selectedChapter || busy) return
    if (!content.trim()) {
      setError('当前章节还没有正文')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const run = await evaluateAndSave({
        novelId,
        chapterId: selectedChapter.id,
        content,
        title: selectedChapter.title,
        useRubric: false,
      })
      if (!run) {
        setError('本书尚未绑定文风配方。请先在「文风」面板绑定一个配方。')
        return
      }
      setReport(run)
      await loadRuns()
    } catch (e) {
      setError(`评估失败：${(e as Error)?.message || '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }

  if (!selectedChapter) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">未选中章节</div>
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">对照本书绑定的文风评估当前正文，只做检测不改稿</span>
        <button
          onClick={evaluate}
          disabled={busy || !content.trim()}
          className={cn(
            'ml-auto flex flex-shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : report ? <RefreshCw size={11} /> : <Gauge size={11} />}
          {busy ? '评估中…' : report ? '重新评估' : '开始评估'}
        </button>
      </div>

      {error && <div className="mx-3 mt-2 rounded bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">{error}</div>}

      {!report && !busy && (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center text-xs leading-relaxed text-muted-foreground/60">
          <Sparkles size={26} className="mb-3 text-muted-foreground/40" />
          还没有文风评估记录。
          <br />
          绑定配方后点「开始评估」，对比本章与目标文风的距离。
        </div>
      )}

      {report && (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <div className="rounded-xl border border-border/30 bg-muted/10 p-4 text-center">
            <div className="text-[10px] text-muted-foreground">像不像你</div>
            <div className="flex items-baseline justify-center gap-1">
              <span className={cn('text-4xl font-bold tabular-nums', scoreLevel(overallOf(report)).color)}>
                {overallOf(report)}
              </span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
            <div className={cn('mt-1 text-[12px] font-medium', scoreLevel(overallOf(report)).color)}>
              {scoreLevel(overallOf(report)).text}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {report.recipeName} · 表达像 {report.styleScore}
              {report.craftScore != null ? ` · 叙事工程像 ${report.craftScore}` : ''}
              {report.rubricScore != null ? ` · 评审分 ${report.rubricScore}` : ''}
            </div>
          </div>

          <section>
            <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">表达层贴合度</h4>
            <div className="space-y-1.5">
              {report.dimensions.map((d) => (
                <div key={d.key} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="text-foreground">{d.label}</span>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      实际 {d.actual} · 目标 {d.target}
                    </span>
                    <span className="w-9 text-right tabular-nums text-foreground">{Math.round(d.adherence * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        d.adherence >= 0.7 ? 'bg-emerald-400' : d.adherence >= 0.4 ? 'bg-yellow-400' : 'bg-red-400',
                      )}
                      style={{ width: `${Math.round(d.adherence * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {!!report.craftDimensions?.length && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">叙事工程层</h4>
              <div className="space-y-1.5">
                {report.craftDimensions.map((d) => (
                  <div key={d.key} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-1.5">
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-foreground">{d.label}</span>
                      {d.detail && <span className="min-w-0 truncate text-muted-foreground">{d.detail}</span>}
                      <span className="ml-auto w-9 flex-shrink-0 text-right tabular-nums text-foreground">{d.score}%</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/5">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          d.score >= 70 ? 'bg-emerald-400' : d.score >= 40 ? 'bg-yellow-400' : 'bg-red-400',
                        )}
                        style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">来源相似度</h4>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg bg-muted/10 px-2 py-1.5">
                <div className="text-[10px] text-muted-foreground">12 字片段重合</div>
                <div className="text-xs tabular-nums text-foreground">{report.similarity.ngramRate}%</div>
              </div>
              <div className="rounded-lg bg-muted/10 px-2 py-1.5">
                <div className="text-[10px] text-muted-foreground">最长连续重合</div>
                <div className="text-xs tabular-nums text-foreground">{report.similarity.longestCommon} 字</div>
              </div>
            </div>
            {!!report.similarity.hits.length && (
              <div className="mt-1.5 space-y-1">
                {report.similarity.hits.map((h, i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex items-start gap-1 rounded px-2 py-1 text-[10px]',
                      h.severity === 'blocking' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400',
                    )}
                  >
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <span>{h.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {!!(report.findings.length || report.craftFindings?.length) && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">需要留意</h4>
              <div className="space-y-1">
                {[...report.findings, ...(report.craftFindings ?? [])].map((f, i) => (
                  <div key={i} className="flex items-start gap-1 rounded bg-muted/10 px-2 py-1 text-[10px] text-foreground/80">
                    <Info size={10} className="mt-0.5 flex-shrink-0 text-muted-foreground" />
                    <span>{f.message}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {runs.length > 1 && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">历史评估</h4>
              <div className="space-y-1">
                {runs.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setReport(r)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] transition-colors',
                      r.id === report.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/20',
                    )}
                  >
                    <span className="tabular-nums">{formatTime(r.createdAt)}</span>
                    <span className="ml-auto tabular-nums">{overallOf(r)} 分</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  )
}
