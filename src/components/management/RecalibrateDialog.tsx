/**
 * 重订走向（8.13）：已写内容的事实 + 未写章现有规划（+ 作者变更说明）
 * → 新旧走向对照审阅（逐条勾选）→ 采纳后只回写未写章的细纲。
 * 已写章节的摘要与正文绝不改动（服务层双重红线）。
 * UI：嵌入 WorkbenchPage 的二级滑出层（标题栏/关闭由外层提供），与 OutlineWizard 同构。
 */
import { useRef, useState } from 'react'
import { Loader2, Square, CheckCircle2, AlertTriangle, Wand2, ArrowRight } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { calibrateOutline, applyCalibration } from '@/services/outline-planner'
import type { RecalibrateDiff } from '@shared/types'

interface Props {
  novelId: string
  onClose: () => void
  onApplied: () => void
}

interface RunState {
  phase: 'idle' | 'running' | 'error'
  message: string
}

const textareaCls =
  'w-full rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 p-2.5 resize-none placeholder:text-muted-foreground/50 leading-relaxed'

export default function RecalibrateDialog({ novelId, onClose, onApplied }: Props) {
  const [notes, setNotes] = useState('')
  const [run, setRun] = useState<RunState>({ phase: 'idle', message: '' })
  const [diff, setDiff] = useState<RecalibrateDiff | null>(null)
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [appliedCount, setAppliedCount] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const runCalibrate = async () => {
    if (run.phase === 'running') return
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ phase: 'running', message: '准备中…' })
    setDiff(null)
    try {
      for await (const p of calibrateOutline(novelId, notes, controller.signal)) {
        setRun({ phase: 'running', message: p.message ?? '' })
        if (p.phase === 'error') { setRun({ phase: 'error', message: p.message ?? '校准失败，请重试' }); return }
        if (p.phase === 'done') {
          const d = p.diff!
          setDiff(d)
          setAccepted(new Set(d.items.map((it) => it.chapterId)))
          setRun({ phase: 'idle', message: '' })
          return
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setRun({ phase: 'error', message: `错误：${e.message}` })
      else setRun({ phase: 'idle', message: '' })
    } finally {
      abortRef.current = null
    }
  }

  const runApply = async () => {
    if (run.phase === 'running' || !diff) return
    const items = diff.items.filter((it) => accepted.has(it.chapterId))
    if (items.length === 0) return
    setRun({ phase: 'running', message: '正在回写未写章细纲…' })
    try {
      const n = await applyCalibration(items)
      setAppliedCount(n)
      setRun({ phase: 'idle', message: '' })
    } catch (e: any) {
      setRun({ phase: 'error', message: `回写失败：${e.message}` })
    }
  }

  const toggle = (id: string) => {
    setAccepted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col">
      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {!diff && appliedCount === null && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              适合这些场景：写了正文后走向变了、中途改了已写的剧情、想让后续章节承接新走向。
              AI 会汇总已写内容和当前规划，给出「旧走向 → 新走向」的对照建议，采纳哪条由你决定。
            </p>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">
                作者说明<span className="ml-1.5 text-muted-foreground/60">可选：你改动了什么、或对后续走向的要求</span>
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="如：第30章结尾已改为女主拒绝告白，后续请按新关系推进"
                className={textareaCls}
              />
            </div>
            <button onClick={runCalibrate} disabled={run.phase === 'running'} className="w-full h-10 rounded-lg border border-dashed border-cyan-500/40 bg-cyan-500/5 text-sm text-cyan-300 hover:bg-cyan-500/10 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40">
              <Wand2 size={13} /> 开始校准
            </button>
          </>
        )}

        {diff && appliedCount === null && (
          <>
            {diff.summary && (
              <div className="text-xs text-cyan-100/90 bg-cyan-500/5 border border-cyan-500/25 rounded-lg px-3.5 py-2.5 leading-relaxed">
                {diff.summary}
              </div>
            )}
            {diff.skipped > 0 && (
              <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-500/5 border border-amber-500/25 rounded-lg px-3 py-2">
                <AlertTriangle size={12} className="flex-shrink-0" />
                有 {diff.skipped} 条建议指向已写章节，已自动忽略——已写内容受保护。
              </div>
            )}
            {diff.items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-3">
                <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
                  <CheckCircle2 size={26} className="text-emerald-400" />
                </div>
                <p className="text-sm text-foreground font-medium">无需调整</p>
                <p className="text-xs text-muted-foreground">未写章的现有规划与已写内容一致。</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>{diff.items.length} 条调整建议</span>
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => setAccepted(new Set(diff.items.map((it) => it.chapterId)))} className="hover:text-foreground transition-colors">全选</button>
                    <span className="text-border/50">|</span>
                    <button onClick={() => setAccepted(new Set())} className="hover:text-foreground transition-colors">全不选</button>
                  </div>
                </div>
                {diff.items.map((it) => (
                  <label
                    key={it.chapterId}
                    className={cn(
                      'block rounded-xl border p-3.5 space-y-2.5 cursor-pointer transition-colors',
                      accepted.has(it.chapterId) ? 'border-cyan-500/35 bg-cyan-500/5' : 'border-border/40 hover:bg-muted/20',
                    )}
                  >
                    <div className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        checked={accepted.has(it.chapterId)}
                        onChange={() => toggle(it.chapterId)}
                        className="accent-cyan-500 w-3.5 h-3.5"
                      />
                      <span className="text-sm font-medium text-foreground">
                        第{it.chapterOrder}章《{it.chapterTitle}》
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">第{it.volumeOrder}卷</span>
                    </div>
                    {it.reason && (
                      <div className="text-xs text-muted-foreground leading-relaxed">理由：{it.reason}</div>
                    )}
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
                      <div className="text-xs space-y-1">
                        <div className="text-muted-foreground/60 text-[10px]">旧走向</div>
                        {it.oldHooks.length ? it.oldHooks.map((h, i) => (
                          <div key={i} className="text-muted-foreground line-through decoration-border/60 leading-relaxed">{h}</div>
                        )) : <div className="text-muted-foreground/50">（暂无）</div>}
                      </div>
                      <ArrowRight size={12} className="text-cyan-400/60 mt-4" />
                      <div className="text-xs space-y-1">
                        <div className="text-cyan-300/80 text-[10px]">新走向</div>
                        {it.newHooks.map((h, i) => (
                          <div key={i} className="text-cyan-100/90 leading-relaxed">{h}</div>
                        ))}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        {appliedCount !== null && (
          <div className="flex flex-col items-center justify-center py-14 space-y-3">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <CheckCircle2 size={28} className="text-emerald-400" />
            </div>
            <p className="text-base text-foreground font-semibold">已更新 {appliedCount} 章的走向</p>
            <p className="text-xs text-muted-foreground">未写章节的细纲已按新走向回写，已写内容未受影响。</p>
          </div>
        )}
      </div>

      {/* Progress / error */}
      {run.phase !== 'idle' && (
        <div className={cn(
          'mx-5 mb-1 px-3 py-2 rounded-lg text-xs flex items-center gap-2 flex-shrink-0',
          run.phase === 'error' ? 'bg-red-500/10 border border-red-500/25 text-red-400' : 'bg-cyan-500/10 border border-cyan-500/25 text-cyan-300',
        )}>
          {run.phase === 'running' && <Loader2 size={12} className="animate-spin flex-shrink-0" />}
          <span className="truncate">{run.message}</span>
          {run.phase === 'running' && (
            <button onClick={() => { abortRef.current?.abort(); abortRef.current = null; setRun({ phase: 'idle', message: '' }) }} className="ml-auto flex items-center gap-1 px-2 h-6 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 text-[11px] flex-shrink-0 transition-colors">
              <Square size={9} /> 停止
            </button>
          )}
          {run.phase === 'error' && (
            <button onClick={() => setRun({ phase: 'idle', message: '' })} className="ml-auto px-2 h-6 rounded-md bg-red-500/15 text-red-300 hover:bg-red-500/25 text-[11px] flex-shrink-0 transition-colors">
              关闭
            </button>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-t border-border/40 flex-shrink-0">
        <div className="ml-auto flex items-center gap-2">
          {diff && appliedCount === null && diff.items.length > 0 && (
            <>
              <span className="text-xs text-muted-foreground">已勾选 {accepted.size} / {diff.items.length} 条</span>
              <Button size="sm" onClick={runApply} disabled={accepted.size === 0 || run.phase === 'running'}>
                采纳所选
              </Button>
            </>
          )}
          {appliedCount !== null ? (
            <Button size="sm" onClick={() => { onApplied(); onClose() }}>
              完成
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {diff ? '关闭' : '取消'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
