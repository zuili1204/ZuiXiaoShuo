import { useState, useEffect, useMemo, useCallback } from 'react'
import { AlertTriangle, Clock, GitBranch, Loader2, MapPin, Plus, Users } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { PlotThread, PlotThreadKind, PlotThreadStatus, TimelineEvent } from '@shared/types'
import {
  computeThreadRisks,
  listPlotThreads,
  listTimelineEvents,
  savePlotThread,
} from '@/services/story-state-service'
import { parseStoryTime } from '@/services/continuity-checker'

const THREAD_KIND_LABELS: Record<PlotThreadKind, string> = {
  main: '主线',
  sub: '支线',
  foreshadow: '伏笔',
  romance: '感情线',
}

const THREAD_STATUS_LABELS: Record<PlotThreadStatus, string> = {
  open: '进行中',
  partial: '部分回收',
  resolved: '已回收',
  abandoned: '已放弃',
}

const STATUS_BADGE: Record<PlotThreadStatus, string> = {
  open: 'bg-primary/15 text-primary',
  partial: 'bg-yellow-500/15 text-yellow-400',
  resolved: 'bg-green-500/15 text-green-400',
  abandoned: 'bg-muted/40 text-muted-foreground',
}

// ===== 时间线 =====

export function TimelineTab({ novelId }: { novelId: string }) {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [orderBy, setOrderBy] = useState<'chapter' | 'story'>('chapter')
  const [character, setCharacter] = useState('')
  const [location, setLocation] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listTimelineEvents(novelId)
      .then((list) => { if (!cancelled) setEvents(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [novelId])

  const characters = useMemo(
    () => Array.from(new Set(events.flatMap((e) => e.characters))).sort(),
    [events]
  )
  const locations = useMemo(
    () => Array.from(new Set(events.map((e) => e.location).filter(Boolean))).sort(),
    [events]
  )

  const visible = useMemo(() => {
    const filtered = events.filter(
      (e) =>
        (!character || e.characters.includes(character)) &&
        (!location || e.location === location)
    )
    if (orderBy === 'chapter') {
      return [...filtered].sort((a, b) => a.chapterOrder - b.chapterOrder)
    }
    const withTime = filtered.map((e, i) => ({ e, i, t: parseStoryTime(e.storyTime) }))
    withTime.sort((a, b) => {
      if (!a.t && !b.t) return a.i - b.i
      if (!a.t) return 1
      if (!b.t) return -1
      if (a.t.unit !== b.t.unit) return a.i - b.i
      return a.t.value - b.t.value
    })
    return withTime.map((x) => x.e)
  }, [events, character, location, orderBy])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">时间线</h3>
        <div className="flex items-center bg-muted/30 rounded p-0.5 text-[10px]">
          <button
            onClick={() => setOrderBy('chapter')}
            className={cn('px-2 py-0.5 rounded', orderBy === 'chapter' ? 'bg-background text-foreground' : 'text-muted-foreground')}
          >
            章节顺序
          </button>
          <button
            onClick={() => setOrderBy('story')}
            className={cn('px-2 py-0.5 rounded', orderBy === 'story' ? 'bg-background text-foreground' : 'text-muted-foreground')}
          >
            故事时间
          </button>
        </div>
      </div>

      {(characters.length > 0 || locations.length > 0) && (
        <div className="flex items-center gap-2 text-[10px]">
          {characters.length > 0 && (
            <select
              value={character}
              onChange={(e) => setCharacter(e.target.value)}
              className="h-6 px-1 rounded bg-muted/20 border border-border/40 text-muted-foreground"
            >
              <option value="">全部角色</option>
              {characters.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {locations.length > 0 && (
            <select
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="h-6 px-1 rounded bg-muted/20 border border-border/40 text-muted-foreground"
            >
              <option value="">全部地点</option>
              {locations.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="py-10 text-center text-xs text-muted-foreground/60 leading-relaxed">
          还没有时间线事件。
          <br />
          旧的作者时间线会自动汇总到这里，后续章节也可继续累积。
        </div>
      ) : (
        <div className="space-y-1.5">
          {visible.map((e) => (
            <div key={e.id} className="rounded-lg border border-border/20 bg-muted/10 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary tabular-nums">
                  第{e.chapterOrder}章
                </span>
                {e.storyTime && (
                  <span className="flex items-center gap-0.5">
                    <Clock size={9} /> {e.storyTime}
                  </span>
                )}
                {e.location && (
                  <span className="flex items-center gap-0.5">
                    <MapPin size={9} /> {e.location}
                  </span>
                )}
                {e.source === 'reader' && (
                  <span className="px-1 rounded bg-muted/40">阅读顺序</span>
                )}
              </div>
              <p className="mt-1 text-xs text-foreground/90 leading-relaxed">{e.event}</p>
              {e.characters.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {e.characters.map((c) => (
                    <span key={c} className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-white/5 text-muted-foreground">
                      <Users size={8} /> {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 剧情线 =====

export function PlotThreadTab({ novelId, currentChapter }: { novelId: string; currentChapter: number }) {
  const [threads, setThreads] = useState<PlotThread[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newKind, setNewKind] = useState<PlotThreadKind>('sub')

  const refresh = useCallback(async () => {
    const list = await listPlotThreads(novelId)
    setThreads(list)
  }, [novelId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listPlotThreads(novelId)
      .then((list) => { if (!cancelled) setThreads(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [novelId])

  const risks = useMemo(
    () => new Map(computeThreadRisks(threads, currentChapter).map((r) => [r.thread.id, r])),
    [threads, currentChapter]
  )

  const groups = useMemo(() => {
    const order: PlotThreadKind[] = ['main', 'sub', 'romance', 'foreshadow']
    return order
      .map((kind) => ({ kind, items: threads.filter((t) => t.kind === kind) }))
      .filter((g) => g.items.length > 0)
  }, [threads])

  const updateThread = async (thread: PlotThread, patch: Partial<PlotThread>) => {
    const next = { ...thread, ...patch }
    setThreads((prev) => prev.map((t) => (t.id === thread.id ? next : t)))
    try {
      await savePlotThread(next)
    } catch (e) {
      console.error('[story-state] update thread failed:', e)
      await refresh()
    }
  }

  const handleAdd = async () => {
    const title = newTitle.trim()
    if (!title) return
    const now = new Date().toISOString()
    try {
      await savePlotThread({
        novelId,
        title,
        kind: newKind,
        status: 'open',
        urgency: newKind === 'main' ? 5 : 2,
        lastTouchedChapter: currentChapter || undefined,
        payoffPlan: '',
        foreshadowingIds: [],
        createdAt: now,
        updatedAt: now,
      })
      setNewTitle('')
      setAdding(false)
      await refresh()
    } catch (e) {
      console.error('[story-state] add thread failed:', e)
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">剧情线</h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-0.5 px-1.5 py-1 rounded text-[10px] bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
        >
          <Plus size={10} /> 新增
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-2.5 py-2 space-y-1.5">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
            placeholder="剧情线名称，例如：玉佩身世"
            className="w-full h-7 px-2 rounded text-xs bg-background/60 border border-border/40"
          />
          <div className="flex items-center gap-1.5">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as PlotThreadKind)}
              className="h-6 px-1 rounded text-[10px] bg-background/60 border border-border/40 text-muted-foreground"
            >
              {(Object.entries(THREAD_KIND_LABELS) as [PlotThreadKind, string][]).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <button onClick={handleAdd} className="px-2 py-1 rounded text-[10px] bg-primary/20 text-primary hover:bg-primary/30">
              添加
            </button>
            <button onClick={() => setAdding(false)} className="px-2 py-1 rounded text-[10px] text-muted-foreground hover:bg-muted/30">
              取消
            </button>
          </div>
        </div>
      )}

      {threads.length === 0 ? (
        <div className="py-10 text-center text-xs text-muted-foreground/60 leading-relaxed">
          还没有剧情线。
          <br />
          现有伏笔会自动汇总为「伏笔」线，也可以手动新增主线或支线。
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.kind}>
            <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-muted-foreground">
              <GitBranch size={11} />
              {THREAD_KIND_LABELS[group.kind]}
              <span className="text-muted-foreground/50">{group.items.length}</span>
            </div>
            <div className="space-y-1.5">
              {group.items.map((t) => {
                const risk = risks.get(t.id)
                return (
                  <div key={t.id} className="rounded-lg border border-border/20 bg-muted/10 px-3 py-2">
                    <div className="flex items-start gap-1.5">
                      <span className="text-xs text-foreground/90 leading-relaxed flex-1">{t.title}</span>
                      <span className={cn('text-[9px] px-1.5 py-0.5 rounded flex-shrink-0', STATUS_BADGE[t.status])}>
                        {THREAD_STATUS_LABELS[t.status]}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      {t.plantedChapter != null && <span>埋设 第{t.plantedChapter}章</span>}
                      {t.plannedResolveChapter != null && <span>计划回收 第{t.plannedResolveChapter}章</span>}
                      {t.lastTouchedChapter != null && <span>最近推进 第{t.lastTouchedChapter}章</span>}
                    </div>
                    {risk && (
                      <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-400">
                        <AlertTriangle size={9} className="mt-0.5 flex-shrink-0" />
                        <span>{risk.reasons.join('；')}</span>
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <select
                        value={t.kind}
                        onChange={(e) => updateThread(t, { kind: e.target.value as PlotThreadKind })}
                        className="h-6 px-1 rounded text-[10px] bg-background/60 border border-border/40 text-muted-foreground"
                      >
                        {(Object.entries(THREAD_KIND_LABELS) as [PlotThreadKind, string][]).map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                      <select
                        value={t.status}
                        onChange={(e) => updateThread(t, {
                          status: e.target.value as PlotThreadStatus,
                          resolvedChapter: e.target.value === 'resolved' ? currentChapter : t.resolvedChapter,
                        })}
                        className="h-6 px-1 rounded text-[10px] bg-background/60 border border-border/40 text-muted-foreground"
                      >
                        {(Object.entries(THREAD_STATUS_LABELS) as [PlotThreadStatus, string][]).map(([k, label]) => (
                          <option key={k} value={k}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
