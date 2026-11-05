import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useWorkbenchStore } from '@/stores'
import { checkChapterContinuity } from '@/services/story-check-service'
import {
  ruleLabel,
  type ContinuityFinding,
} from '@/services/continuity-checker'

export default function ContinuityPanel({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const [findings, setFindings] = useState<ContinuityFinding[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!selectedChapter) return
    setLoading(true)
    setError(null)
    try {
      const content = useWorkbenchStore.getState().editorContent || ''
      const result = await checkChapterContinuity({
        novelId,
        chapterId: selectedChapter.id,
        chapterOrder: selectedChapter.order,
        hooks: selectedChapter.hooks ?? [],
        content,
      })
      setFindings(result)
      setCheckedAt(new Date().toISOString())
    } catch (e) {
      setError(`对轨失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [novelId, selectedChapter])

  useEffect(() => {
    setFindings(null)
    void run()
  }, [run])

  if (!selectedChapter) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <ShieldCheck size={26} className="text-muted-foreground/30 mb-2" />
        <p className="text-xs text-muted-foreground/60">先选择一个章节，再对轨检查</p>
      </div>
    )
  }

  const blocking = findings?.filter((f) => f.severity === 'blocking') ?? []
  const warnings = findings?.filter((f) => f.severity === 'warning') ?? []

  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground truncate">
          《{selectedChapter.title}》
          {checkedAt ? ` · ${new Date(checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button
          onClick={() => void run()}
          disabled={loading}
          className={cn(
            'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {loading ? '对轨中…' : '重新对轨'}
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-red-500/10 text-[11px] text-red-400">{error}</div>
      )}

      {loading && !findings ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">正在核对话状态、时间线与剧情线…</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/30 bg-red-500/5 px-3 py-2">
              <div className="text-lg font-semibold tabular-nums text-red-400">{blocking.length}</div>
              <div className="text-[10px] text-muted-foreground">硬伤（需处理）</div>
            </div>
            <div className="rounded-lg border border-border/30 bg-amber-500/5 px-3 py-2">
              <div className="text-lg font-semibold tabular-nums text-amber-400">{warnings.length}</div>
              <div className="text-[10px] text-muted-foreground">提示（可确认后忽略）</div>
            </div>
          </div>

          {findings && findings.length === 0 && (
            <div className="py-8 flex flex-col items-center text-center gap-2">
              <CheckCircle2 size={26} className="text-emerald-400/80" />
              <p className="text-xs text-muted-foreground">未发现可结构化判定的问题</p>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed px-6">
                语义层面的矛盾仍需人工或一致性检查技能确认。
              </p>
            </div>
          )}

          {blocking.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-red-400">
                <AlertTriangle size={11} /> 硬伤
              </div>
              <div className="space-y-1.5">
                {blocking.map((f, i) => <FindingCard key={`b${i}`} finding={f} />)}
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
                <Info size={11} /> 提示
              </div>
              <div className="space-y-1.5">
                {warnings.map((f, i) => <FindingCard key={`w${i}`} finding={f} />)}
              </div>
            </div>
          )}

          <p className="pt-1 text-[10px] text-muted-foreground/60 leading-relaxed">
            只校验能被结构化状态判定的内容（角色生死、物品/能力解锁章、故事时间、剧情线逾期等），不会改写正文。
          </p>
        </div>
      )}
    </>
  )
}

function FindingCard({ finding }: { finding: ContinuityFinding }) {
  const blocking = finding.severity === 'blocking'
  return (
    <div className={cn(
      'rounded-lg border px-2.5 py-2',
      blocking ? 'border-red-500/20 bg-red-500/5' : 'border-border/20 bg-muted/10'
    )}>
      <div className="flex items-center gap-1.5">
        <span className={cn(
          'text-[9px] px-1.5 py-0.5 rounded',
          blocking ? 'bg-red-500/15 text-red-400' : 'bg-white/5 text-muted-foreground'
        )}>
          {ruleLabel(finding.ruleId)}
        </span>
        {finding.location && (
          <span className="text-[9px] text-muted-foreground/70">{finding.location}</span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-foreground/90 leading-relaxed">{finding.message}</div>
      {finding.evidence && (
        <div className="mt-1 text-[10px] text-muted-foreground/80 leading-relaxed whitespace-pre-wrap border-l-2 border-border/40 pl-1.5">
          {finding.evidence}
        </div>
      )}
      {finding.suggestion && (
        <div className="mt-1 text-[10px] text-muted-foreground/70">建议：{finding.suggestion}</div>
      )}
    </div>
  )
}
