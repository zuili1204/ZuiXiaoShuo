import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Loader2,
  Pin,
  PinOff,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import {
  assembleContext,
  CONTEXT_SECTION_LABELS,
  loadContextPlanOverrides,
  planContextBundle,
  saveContextPlanOverrides,
} from '@/services/context-assembler'
import type {
  ContextBundle,
  ContextPlanOverrides,
  ContextSection,
  ContextSectionKey,
  ContextTask,
} from '@shared/types'
import { cn } from '@/utils/cn'

const TASK_LABEL: Record<ContextTask, string> = {
  write: '写作',
  revise: '改写',
  check: '检查',
  ask: '问答',
}

function formatTokens(n: number): string {
  return n.toLocaleString('zh-CN')
}

function sameKeys(a: string[] | undefined, b: ContextSectionKey): boolean {
  return (a ?? []).includes(b)
}

export default function ContextPreviewPanel({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const editorContent = useWorkbenchStore((s) => s.editorContent)

  const [bundle, setBundle] = useState<ContextBundle | null>(null)
  const [overrides, setOverrides] = useState<ContextPlanOverrides>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ContextSectionKey | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await assembleContext({
        novelId,
        chapter: selectedChapter,
        chapterContent: editorContent || undefined,
        previousMessages: [],
      })
      setBundle(next)
      setOverrides(await loadContextPlanOverrides(novelId))
    } catch (e) {
      setError(`装配上下文失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [novelId, selectedChapter, editorContent])

  useEffect(() => {
    void load()
  }, [load])

  // 固定/排除切换只重算计划，不重新读库，保证交互即时
  const plan = useMemo(() => {
    if (!bundle) return null
    return planContextBundle(bundle, {
      budgetTokens: bundle.contextPlan?.budgetTokens,
      task: bundle.contextPlan?.task,
      overrides,
    })
  }, [bundle, overrides])

  const persist = useCallback(
    (next: ContextPlanOverrides) => {
      setOverrides(next)
      void saveContextPlanOverrides(novelId, next).catch(() => {
        /* 偏好写入失败不影响本次查看 */
      })
    },
    [novelId]
  )

  const togglePin = (key: ContextSectionKey) => {
    if (key === 'safety') return
    const pinned = sameKeys(overrides.pin, key)
    const pin = pinned ? (overrides.pin ?? []).filter((k) => k !== key) : [...(overrides.pin ?? []), key]
    const exclude = (overrides.exclude ?? []).filter((k) => k !== key)
    persist({ pin, exclude })
  }

  const toggleExclude = (key: ContextSectionKey) => {
    if (key === 'safety') return
    const excluded = sameKeys(overrides.exclude, key)
    const exclude = excluded ? (overrides.exclude ?? []).filter((k) => k !== key) : [...(overrides.exclude ?? []), key]
    const pin = (overrides.pin ?? []).filter((k) => k !== key)
    persist({ pin, exclude })
  }

  if (loading && !plan) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2">
          <Loader2 size={20} className="animate-spin text-muted-foreground" />
          <span className="text-[11px] text-muted-foreground">正在装配上下文…</span>
        </div>
      </div>
    )
  }

  if (error || !plan) {
    return (
      <>
        <div className="px-3 py-2 border-b border-border/20 flex items-center">
          <span className="text-[11px] text-muted-foreground">上下文预览</span>
          <button
            onClick={() => void load()}
            className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
          >
            <RefreshCw size={11} />
            重试
          </button>
        </div>
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-red-500/10 text-[11px] text-red-400">
          {error ?? '暂无上下文数据'}
        </div>
      </>
    )
  }

  const usage = plan.budgetTokens > 0 ? Math.min(plan.totalTokens / plan.budgetTokens, 1) : 0
  const overBudget = plan.totalTokens > plan.budgetTokens

  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center">
        <span className="text-[11px] text-muted-foreground">
          {TASK_LABEL[plan.task]}任务 · 预算 {formatTokens(plan.budgetTokens)} token
        </span>
        <button
          onClick={() => void load()}
          disabled={loading}
          className={cn(
            'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40'
          )}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          重新装配
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* 总量 */}
        <div className="rounded-xl border border-border/30 bg-muted/10 p-3">
          <div className="flex items-baseline gap-1">
            <span className={cn('text-2xl font-bold tabular-nums', overBudget ? 'text-amber-400' : 'text-foreground')}>
              {formatTokens(plan.totalTokens)}
            </span>
            <span className="text-[11px] text-muted-foreground">/ {formatTokens(plan.budgetTokens)} token</span>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-muted/40 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', overBudget ? 'bg-amber-400' : 'bg-primary/70')}
              style={{ width: `${Math.round(usage * 100)}%` }}
            />
          </div>
          <div className="mt-1.5 text-[10px] text-muted-foreground/70">
            {overBudget ? '已超出预算，注入时会继续裁剪低优先级区块' : '按区块预算装配，事实类优先保留'}
          </div>
        </div>

        {plan.dropped.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
            <div className="flex items-center gap-1 text-[10px] text-amber-400">
              <AlertTriangle size={10} />
              本次裁剪 {plan.dropped.length} 处
            </div>
            <ul className="mt-1 space-y-0.5">
              {plan.dropped.map((d, i) => (
                <li key={`${d.key}-${i}`} className="text-[10px] text-muted-foreground leading-relaxed">
                  {CONTEXT_SECTION_LABELS[d.key]}：{d.reason}
                  {d.tokens ? `（−${formatTokens(d.tokens)} token）` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 区块列表 */}
        <div className="mt-3 space-y-1.5">
          {plan.sections.map((section) => (
            <SectionRow
              key={section.key}
              section={section}
              pinned={sameKeys(overrides.pin, section.key)}
              excluded={sameKeys(overrides.exclude, section.key)}
              expanded={expanded === section.key}
              onToggleExpand={() => setExpanded(expanded === section.key ? null : section.key)}
              onTogglePin={() => togglePin(section.key)}
              onToggleExclude={() => toggleExclude(section.key)}
            />
          ))}
        </div>

        <div className="mt-3 flex items-start gap-1 text-[10px] text-muted-foreground/60 leading-relaxed">
          <ShieldCheck size={10} className="mt-0.5 flex-shrink-0" />
          仅在本机装配与预览，不会上传任何内容；固定/排除偏好按本书保存。
        </div>
      </div>
    </>
  )
}

function SectionRow({
  section,
  pinned,
  excluded,
  expanded,
  onToggleExpand,
  onTogglePin,
  onToggleExclude,
}: {
  section: ContextSection
  pinned: boolean
  excluded: boolean
  expanded: boolean
  onToggleExpand: () => void
  onTogglePin: () => void
  onToggleExclude: () => void
}) {
  const locked = section.key === 'safety'
  const hasContent = !!section.content

  return (
    <div
      className={cn(
        'rounded-lg border px-2.5 py-2 transition-colors',
        excluded ? 'border-border/20 bg-muted/5 opacity-60' : 'border-border/30 bg-muted/10'
      )}
    >
      <div className="flex items-center gap-1.5">
        <button
          onClick={onToggleExpand}
          disabled={!hasContent}
          className="flex items-center gap-1 text-[12px] text-foreground font-medium disabled:cursor-default"
        >
          {hasContent ? (
            expanded ? <ChevronUp size={12} className="text-muted-foreground" /> : <ChevronDown size={12} className="text-muted-foreground" />
          ) : (
            <span className="w-3" />
          )}
          {CONTEXT_SECTION_LABELS[section.key]}
        </button>
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground tabular-nums">
          {formatTokens(section.tokens)} tok
        </span>
        {pinned && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">固定</span>
        )}
        {!locked && (
          <div className="ml-auto flex items-center gap-0.5">
            <button
              onClick={onTogglePin}
              aria-label={pinned ? '取消固定' : '固定此区块'}
              title={pinned ? '取消固定' : '固定：裁剪时保留'}
              className={cn(
                'p-1 rounded transition-colors',
                pinned ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
              )}
            >
              {pinned ? <PinOff size={11} /> : <Pin size={11} />}
            </button>
            <button
              onClick={onToggleExclude}
              aria-label={excluded ? '恢复注入' : '本次不注入'}
              title={excluded ? '恢复注入' : '本次不注入'}
              className={cn(
                'p-1 rounded transition-colors',
                excluded ? 'text-amber-400 bg-amber-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
              )}
            >
              <EyeOff size={11} />
            </button>
          </div>
        )}
      </div>

      <div className="mt-0.5 text-[10px] text-muted-foreground/70">{section.reason}</div>

      {expanded && hasContent && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded bg-background/40 border border-border/20 px-2 py-1.5">
          <div className="whitespace-pre-wrap text-[10px] leading-relaxed text-foreground/80">{section.content}</div>
        </div>
      )}
    </div>
  )
}
