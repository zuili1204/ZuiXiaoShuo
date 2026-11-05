import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Flame, Archive, ChevronDown, ChevronUp, ListTree, ClipboardList,
  GitBranch, Target, CheckCircle2, CircleDot, Circle,
} from 'lucide-react'
import { volumeService, chapterService } from '@/services/data-service'
import { listSceneCards } from '@/services/scene-service'
import {
  getDailyStats, setDailyWordGoal, getPublishedChapter, setPublishedChapter,
  computeBacklog, recoverPendingSession, subscribeSessionChanges,
  type DailyStats,
} from '@/services/session-service'
import { useWorkbenchStore } from '@/stores'
import { cn } from '@/utils/cn'
import type { Chapter, SceneCard } from '@shared/types'

interface DailyCockpitProps {
  novelId: string
  onOpenTracking: () => void
}

interface UpcomingChapter {
  id: string
  title: string
  order: number
  status: Chapter['status']
  wordCount: number
  hooks: string[]
  summary?: string
}

const STATUS_META: Record<string, { label: string; className: string; icon: typeof Circle }> = {
  final: { label: '已定稿', className: 'text-emerald-400 bg-emerald-500/10', icon: CheckCircle2 },
  writing: { label: '写作中', className: 'text-amber-300 bg-amber-500/10', icon: CircleDot },
  outlined: { label: '有细纲', className: 'text-primary bg-primary/10', icon: CircleDot },
  empty: { label: '无细纲', className: 'text-muted-foreground bg-muted/30', icon: Circle },
}

function chapterStatusKey(ch: UpcomingChapter): keyof typeof STATUS_META {
  if (ch.status === 'final') return 'final'
  if (ch.wordCount > 0 || ch.status === 'reviewed' || ch.status === 'polished') return 'writing'
  if ((ch.hooks?.length ?? 0) > 0 || ch.summary) return 'outlined'
  return 'empty'
}

export default function DailyCockpit({ novelId, onOpenTracking }: DailyCockpitProps) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)
  const setEditorDrawer = useWorkbenchStore((s) => s.setEditorDrawer)
  const wordCount = useWorkbenchStore((s) => s.wordCount)

  const [expanded, setExpanded] = useState(true)
  const [stats, setStats] = useState<DailyStats | null>(null)
  const [chapters, setChapters] = useState<UpcomingChapter[]>([])
  const [scenes, setScenes] = useState<SceneCard[]>([])
  const [published, setPublished] = useState(0)
  const [goalDraft, setGoalDraft] = useState('')
  const [publishedDraft, setPublishedDraft] = useState('')
  const goalFocusedRef = useRef(false)
  const publishedFocusedRef = useRef(false)

  const loadStats = useCallback(async () => {
    const next = await getDailyStats(novelId)
    setStats(next)
  }, [novelId])

  const loadStructure = useCallback(async () => {
    const volumes = await volumeService.getByNovelId(novelId)
    const ordered: UpcomingChapter[] = []
    for (const v of volumes) {
      const list = await chapterService.getByVolumeId(v.id)
      for (const ch of list) {
        ordered.push({
          id: ch.id,
          title: ch.title,
          order: ch.order,
          status: ch.status,
          wordCount: ch.wordCount,
          hooks: ch.hooks ?? [],
          summary: ch.summary,
        })
      }
    }
    setChapters(ordered)
    setPublished(await getPublishedChapter(novelId))
  }, [novelId])

  const loadScenes = useCallback(async () => {
    if (!selectedChapter?.id) {
      setScenes([])
      return
    }
    setScenes(await listSceneCards(selectedChapter.id))
  }, [selectedChapter?.id])

  useEffect(() => {
    if (!novelId) return
    let cancelled = false
    // 首次打开补记异常退出遗留的会话（已补记过则无操作）
    recoverPendingSession(novelId)
      .catch(() => false)
      .then(() => {
        if (cancelled) return
        loadStats()
        loadStructure()
      })
    return () => { cancelled = true }
  }, [novelId, loadStats, loadStructure])

  useEffect(() => {
    void loadScenes()
  }, [loadScenes])

  // 保存/落盘/修正后即时刷新今日字数；跨天时 30 秒内自动归零
  useEffect(() => {
    return subscribeSessionChanges((id) => {
      if (id === novelId) void loadStats()
    })
  }, [novelId, loadStats])

  useEffect(() => {
    const t = setTimeout(() => { void loadStats() }, 500)
    return () => clearTimeout(t)
  }, [wordCount, loadStats])

  useEffect(() => {
    const refresh = () => {
      void loadStats()
      void loadStructure()
      void loadScenes()
    }
    const timer = setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [loadStats, loadStructure, loadScenes])

  useEffect(() => {
    if (stats && !goalFocusedRef.current) setGoalDraft(String(stats.goal))
  }, [stats?.goal])

  useEffect(() => {
    if (!publishedFocusedRef.current) setPublishedDraft(String(published))
  }, [published])

  const activeScenes = scenes.filter((s) => s.status !== 'cut')
  const writtenScenes = activeScenes.filter((s) => s.status === 'written').length

  const currentIdx = chapters.findIndex((c) => c.id === selectedChapter?.id)
  const upcoming = currentIdx >= 0 ? chapters.slice(currentIdx + 1, currentIdx + 4) : chapters.slice(0, 3)

  const backlog = computeBacklog(
    chapters.map((c) => ({ status: c.status, wordCount: c.wordCount })),
    published,
  )

  const todayWords = stats?.todayWords ?? 0
  const goal = stats?.goal ?? 0
  const progress = goal > 0 ? Math.min(1, todayWords / goal) : 0
  const met = goal > 0 && todayWords >= goal

  const currentWords = selectedChapter ? (wordCount || selectedChapter.wordCount) : 0
  const currentTarget = selectedChapter?.targetWordCount || 3000
  const weekMax = Math.max(goal, ...(stats?.week ?? []).map((d) => d.words), 1)

  const commitGoal = async () => {
    goalFocusedRef.current = false
    const n = Number(goalDraft)
    if (!Number.isFinite(n) || n < 0) {
      setGoalDraft(String(goal))
      return
    }
    await setDailyWordGoal(novelId, n)
    await loadStats()
  }

  const commitPublished = async () => {
    publishedFocusedRef.current = false
    const n = Number(publishedDraft)
    if (!Number.isFinite(n) || n < 0) {
      setPublishedDraft(String(published))
      return
    }
    await setPublishedChapter(novelId, n)
    setPublished(Math.max(0, Math.floor(n)))
  }

  const openDrawer = (view: 'scenes' | 'state') => {
    if (!selectedChapter) return
    setEditorDrawer(view)
  }

  return (
    <div className="shrink-0 border-b border-border/30 bg-sidebar/70 select-none">
      {/* 首行：今日进度 / 连续天数 / 近 7 天 / 存稿 / 快捷入口 */}
      <div className="h-12 flex items-center gap-3 px-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title={expanded ? '收起驾驶舱' : '展开驾驶舱'}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        <div className="flex items-center gap-2">
          <div className="relative w-9 h-9 flex items-center justify-center">
            <svg viewBox="0 0 36 36" className="w-9 h-9 -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-muted/40" />
              <circle
                cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" pathLength={100}
                strokeDasharray={`${progress * 100} 100`}
                strokeLinecap="round"
                className={met ? 'stroke-emerald-400 transition-all duration-500' : 'stroke-primary transition-all duration-500'}
              />
            </svg>
            <Target size={12} className={cn('absolute', met ? 'text-emerald-400' : 'text-primary/70')} />
          </div>
          <div className="leading-tight">
            <div className="text-[11px] text-foreground">
              今日 <span className={cn('font-semibold', met ? 'text-emerald-400' : 'text-foreground')}>{todayWords.toLocaleString()}</span>
              <span className="text-muted-foreground"> / {goal.toLocaleString()} 字</span>
            </div>
            <div className="text-[9px] text-muted-foreground">
              {goal > 0 && todayWords >= goal ? '今日已达标' : `还差 ${Math.max(0, goal - todayWords).toLocaleString()} 字`}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 text-[10px] text-amber-300" title="连续达标天数">
          <Flame size={12} />
          <span>{stats?.streak ?? 0} 天</span>
        </div>

        <div className="hidden md:flex items-center gap-2 pl-2 border-l border-border/30">
          <div className="flex items-end gap-[3px] h-6" title="近 7 天净增字数">
            {(stats?.week ?? []).map((d) => {
              const h = d.words > 0 ? Math.max(3, Math.round((d.words / weekMax) * 24)) : 2
              const isToday = d.date === stats?.today
              return (
                <div
                  key={d.date}
                  style={{ height: `${h}px` }}
                  className={cn(
                    'w-[6px] rounded-sm transition-all',
                    isToday ? 'bg-primary' : d.words >= goal ? 'bg-emerald-400/70' : 'bg-primary/30',
                    d.words === 0 && 'bg-muted/40',
                  )}
                  title={`${d.date} · ${d.words.toLocaleString()} 字`}
                />
              )
            })}
          </div>
          <div className="leading-tight text-[9px] text-muted-foreground">
            <div>近 7 天 {(stats?.weekWords ?? 0).toLocaleString()} 字</div>
            <div>本周 {stats?.weekChapters ?? 0} 章有推进</div>
          </div>
        </div>

        <div className="hidden lg:flex items-center gap-1.5 pl-2 border-l border-border/30 text-[10px] text-muted-foreground">
          <Archive size={12} className="text-sky-300/80" />
          <span title="已定稿且尚未发布的章节">
            存稿 <span className="text-foreground">{backlog.chapters}</span> 章 · {backlog.words.toLocaleString()} 字
          </span>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <button
            onClick={() => openDrawer('scenes')}
            disabled={!selectedChapter}
            className="px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-40 transition-colors"
            title="打开章节场景卡"
          >
            <ListTree size={11} className="inline mr-1" />
            场景
          </button>
          <button
            onClick={() => openDrawer('state')}
            disabled={!selectedChapter}
            className="px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-40 transition-colors"
            title="打开创作状态卡"
          >
            <ClipboardList size={11} className="inline mr-1" />
            状态
          </button>
          <button
            onClick={onOpenTracking}
            className="px-1.5 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            title="打开创作追踪"
          >
            <GitBranch size={11} className="inline mr-1" />
            追踪
          </button>
        </div>
      </div>

      {/* 次行：当前章 / 未来 3 章 / 目标与发布设置 */}
      {expanded && (
        <div className="h-9 flex items-center gap-4 px-3 pb-2 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-muted-foreground/70">当前章</span>
            {selectedChapter ? (
              <>
                <span className="text-foreground/80 truncate max-w-[160px]" title={selectedChapter.title}>
                  {selectedChapter.title}
                </span>
                <span className={cn(currentWords >= currentTarget ? 'text-emerald-400' : 'text-amber-300')}>
                  {currentWords.toLocaleString()} / {currentTarget.toLocaleString()} 字
                </span>
                <span className="text-muted-foreground/60">
                  场景 {writtenScenes}/{activeScenes.length}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground/50">未选择章节</span>
            )}
          </div>

          <div className="flex items-center gap-1.5 pl-3 border-l border-border/30 min-w-0">
            <span className="text-muted-foreground/70">未来</span>
            {upcoming.length === 0 ? (
              <span className="text-muted-foreground/40">已是最后一章</span>
            ) : (
              upcoming.map((ch) => {
                const key = chapterStatusKey(ch)
                const meta = STATUS_META[key]
                const Icon = meta.icon
                return (
                  <button
                    key={ch.id}
                    onClick={() => {
                      chapterService.getById(ch.id).then((full) => { if (full) selectChapter(full) }).catch(() => {})
                    }}
                    className={cn(
                      'flex items-center gap-1 px-1.5 py-0.5 rounded max-w-[150px] transition-colors hover:brightness-125',
                      meta.className,
                    )}
                    title={`第${ch.order}章 · ${meta.label}`}
                  >
                    <Icon size={9} />
                    <span className="truncate">第{ch.order}章 {ch.title}</span>
                  </button>
                )
              })
            )}
          </div>

          <div className="flex-1" />

          <label className="flex items-center gap-1" title="每日目标字数">
            <Target size={10} />
            <span>日目标</span>
            <input
              type="number"
              min={0}
              step={500}
              value={goalDraft}
              onFocus={() => { goalFocusedRef.current = true }}
              onChange={(e) => setGoalDraft(e.target.value)}
              onBlur={() => void commitGoal()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="w-14 h-5 rounded bg-muted/30 border border-border/60 text-center text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <span>字</span>
          </label>

          <label className="flex items-center gap-1" title="已发布到第几章（用于计算存稿）">
            <Archive size={10} />
            <span>已发布</span>
            <input
              type="number"
              min={0}
              step={1}
              value={publishedDraft}
              onFocus={() => { publishedFocusedRef.current = true }}
              onChange={(e) => setPublishedDraft(e.target.value)}
              onBlur={() => void commitPublished()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="w-12 h-5 rounded bg-muted/30 border border-border/60 text-center text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            <span>章</span>
          </label>
        </div>
      )}
    </div>
  )
}
