import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GitCompare, Loader2, Check, X, ListChecks, ArrowRight,
  Plus, Trash2, ShieldAlert,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useWorkbenchStore } from '@/stores'
import { chapterService } from '@/services/data-service'
import {
  createSnapshot,
  listSnapshots,
  readSnapshot,
  snapshotSourceLabel,
  type SnapshotMeta,
} from '@/services/snapshot-service'
import { indexChapterContent } from '@/services/rag-service'
import {
  addRevisionTask,
  analyzeImpact,
  applyDiff,
  collectKnownEntities,
  computeDiff,
  deleteRevisionTask,
  extractChangedEntities,
  listNovelChapters,
  loadRevisionTasks,
  runCascadeCheck,
  updateRevisionTaskStatus,
  type NovelChapterRef,
} from '@/services/revision-service'
import {
  REVISION_TASK_STATUS_LABEL,
  REVISION_TASK_TYPE_LABEL,
  type CascadeReport,
  type DiffResult,
  type ImpactEntity,
  type ImpactReport,
  type RevisionTask,
  type RevisionTaskStatus,
  type RevisionTaskType,
} from '@shared/revision-types'

type Tab = 'diff' | 'impact' | 'tasks'

const TABS: { id: Tab; label: string }[] = [
  { id: 'diff', label: '版本对比' },
  { id: 'impact', label: '影响分析' },
  { id: 'tasks', label: '修订任务' },
]

const TASK_TYPE_OPTIONS: RevisionTaskType[] = ['continuity', 'outline', 'polish', 'rewrite']
const TASK_FILTERS: { id: 'all' | RevisionTaskStatus; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '待处理' },
  { id: 'done', label: '已确认' },
  { id: 'ignored', label: '已忽略' },
]

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function RevisionPanel({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const editorContent = useWorkbenchStore((s) => s.editorContent)
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)
  const setSelectedVolumeId = useWorkbenchStore((s) => s.setSelectedVolumeId)
  const setEditorDrawer = useWorkbenchStore((s) => s.setEditorDrawer)
  const reloadEditor = useWorkbenchStore((s) => s.reloadEditor)

  const [tab, setTab] = useState<Tab>('diff')
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([])
  const [snapshotName, setSnapshotName] = useState('')
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [accepted, setAccepted] = useState<Record<string, boolean>>({})
  const [diffLoading, setDiffLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  const [entities, setEntities] = useState<ImpactEntity[]>([])
  const [keyword, setKeyword] = useState('')
  const [impact, setImpact] = useState<ImpactReport | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [cascade, setCascade] = useState<CascadeReport | null>(null)
  const [cascadeLoading, setCascadeLoading] = useState(false)

  const [tasks, setTasks] = useState<RevisionTask[]>([])
  const [taskFilter, setTaskFilter] = useState<'all' | RevisionTaskStatus>('open')
  const [refs, setRefs] = useState<NovelChapterRef[]>([])
  const [taskTarget, setTaskTarget] = useState('')
  const [taskType, setTaskType] = useState<RevisionTaskType>('continuity')
  const [taskDesc, setTaskDesc] = useState('')

  const [msg, setMsg] = useState<string | null>(null)
  const msgTimer = useRef<number | null>(null)

  const flash = useCallback((text: string) => {
    setMsg(text)
    if (msgTimer.current) window.clearTimeout(msgTimer.current)
    msgTimer.current = window.setTimeout(() => setMsg(null), 4000)
  }, [])

  useEffect(() => () => {
    if (msgTimer.current) window.clearTimeout(msgTimer.current)
  }, [])

  const chapterId = selectedChapter?.id ?? ''

  const refreshSnapshots = useCallback(async () => {
    if (!chapterId) {
      setSnapshots([])
      setSnapshotName('')
      return
    }
    const metas = await listSnapshots(chapterId)
    setSnapshots(metas)
    setSnapshotName((prev) => (metas.some((m) => m.name === prev) ? prev : metas[0]?.name ?? ''))
  }, [chapterId])

  const refreshTasks = useCallback(async () => {
    setTasks(await loadRevisionTasks(novelId))
  }, [novelId])

  // 切章即清空对比/影响结果，避免把上一章的 diff 当成当前章
  useEffect(() => {
    setDiff(null)
    setAccepted({})
    setEntities([])
    setImpact(null)
    setCascade(null)
    setMsg(null)
    void refreshSnapshots()
  }, [chapterId, refreshSnapshots])

  useEffect(() => {
    void refreshTasks()
    void listNovelChapters(novelId).then((list) => {
      setRefs(list)
      setTaskTarget((prev) =>
        prev && prev !== chapterId && list.some((r) => r.chapter.id === prev)
          ? prev
          : list.find((r) => r.chapter.id !== chapterId)?.chapter.id ?? ''
      )
    })
  }, [novelId, chapterId, refreshTasks])

  const taskTitle = useCallback(
    (id: string) => refs.find((r) => r.chapter.id === id)?.chapter.title ?? '未知章节',
    [refs]
  )

  const currentText = useCallback(async () => {
    if (!chapterId) return ''
    return editorContent || (await chapterService.loadContent(chapterId))
  }, [chapterId, editorContent])

  const buildDiff = useCallback(async (): Promise<DiffResult | null> => {
    if (!chapterId) return null
    const name = snapshotName || snapshots[0]?.name
    if (!name) {
      flash('还没有可对比的快照，先留一份当前版本')
      return null
    }
    const oldText = await readSnapshot(chapterId, name)
    return computeDiff(oldText, await currentText())
  }, [chapterId, snapshotName, snapshots, currentText, flash])

  const handleSnapshotNow = async () => {
    if (!chapterId) return
    const created = await createSnapshot(chapterId, 'manual', { force: true })
    flash(created ? '已留一份当前版本' : '当前章节内容为空，无需快照')
    await refreshSnapshots()
  }

  const handleCompare = async () => {
    setDiffLoading(true)
    try {
      const result = await buildDiff()
      if (!result) return
      setDiff(result)
      setAccepted({})
      setImpact(null)
      setCascade(null)
      setEntities(extractChangedEntities(result.segments, await collectKnownEntities(novelId)))
      if (result.summary.added + result.summary.removed === 0) flash('两版内容一致，没有差异')
    } catch (e) {
      flash(`对比失败：${(e as Error).message}`)
    } finally {
      setDiffLoading(false)
    }
  }

  const setAllChanges = (adopt: boolean) => {
    if (!diff) return
    const next: Record<string, boolean> = {}
    diff.segments.forEach((seg) => {
      if (seg.kind !== 'equal') next[seg.key] = adopt
    })
    setAccepted(next)
  }

  const toggleSegment = (key: string) => {
    setAccepted((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }))
  }

  const handleApply = async () => {
    if (!diff || !chapterId || !selectedChapter) return
    setApplying(true)
    try {
      const next = applyDiff(diff.segments, accepted)
      // 应用前强制留底：即便误操作也能从「历史版本」恢复
      await createSnapshot(chapterId, 'manual', { force: true })
      await chapterService.saveContent(chapterId, next)
      indexChapterContent(novelId, chapterId, selectedChapter.title, next, selectedChapter.order)
      reloadEditor()
      flash('已应用改动（应用前的内容已自动留底）')
      await refreshSnapshots()
    } catch (e) {
      flash(`应用失败：${(e as Error).message}`)
    } finally {
      setApplying(false)
    }
  }

  const addKeyword = () => {
    const name = keyword.trim()
    if (name.length < 2) {
      flash('关键词至少两个字')
      return
    }
    if (entities.some((e) => e.name === name)) {
      setKeyword('')
      return
    }
    setEntities((prev) => [...prev, { name, kind: 'keyword' }])
    setKeyword('')
  }

  const handleAnalyze = async () => {
    if (!chapterId) return
    setImpactLoading(true)
    try {
      let segments = diff?.segments
      if (!segments) {
        const result = await buildDiff()
        if (!result) return
        setDiff(result)
        setAccepted({})
        segments = result.segments
      }
      const known = await collectKnownEntities(novelId)
      const auto = extractChangedEntities(segments, known)
      const merged: ImpactEntity[] = []
      const seen = new Set<string>()
      for (const entity of [...entities, ...auto]) {
        if (entity.name.length < 2 || seen.has(entity.name)) continue
        seen.add(entity.name)
        merged.push(entity)
      }
      if (!merged.length) {
        flash('改动里没有识别到已知角色或物品，可在下方手动补充关键词')
        return
      }
      setEntities(merged)
      setImpact(await analyzeImpact({ novelId, sourceChapterId: chapterId, entities: merged }))
      setCascade(null)
    } catch (e) {
      flash(`影响分析失败：${(e as Error).message}`)
    } finally {
      setImpactLoading(false)
    }
  }

  const handleCascade = async () => {
    if (!impact) return
    const ids = Array.from(new Set(impact.hits.map((h) => h.chapterId)))
    if (!ids.length) {
      flash('没有命中后续章节，无需级联检查')
      return
    }
    setCascadeLoading(true)
    try {
      setCascade(await runCascadeCheck({ novelId, chapterIds: ids }))
    } catch (e) {
      flash(`级联检查失败：${(e as Error).message}`)
    } finally {
      setCascadeLoading(false)
    }
  }

  const handleAddCascadeTask = async (hit: ImpactReport['hits'][number]) => {
    if (!chapterId) return
    try {
      await addRevisionTask({
        novelId,
        sourceChapterId: chapterId,
        targetChapterId: hit.chapterId,
        type: 'continuity',
        description: `确认「${hit.entity}」相关改动后，本章是否仍一致：${hit.sentence}`,
      })
      await refreshTasks()
      flash('已加入级联清单')
    } catch (e) {
      flash(`加入失败：${(e as Error).message}`)
    }
  }

  const handleCreateTask = async () => {
    if (!chapterId || !taskTarget || !taskDesc.trim()) {
      flash('请选择目标章并填写任务说明')
      return
    }
    try {
      await addRevisionTask({
        novelId,
        sourceChapterId: chapterId,
        targetChapterId: taskTarget,
        type: taskType,
        description: taskDesc.trim(),
      })
      setTaskDesc('')
      await refreshTasks()
      flash('任务已创建')
    } catch (e) {
      flash(`创建失败：${(e as Error).message}`)
    }
  }

  const handleStatus = async (taskId: string, status: RevisionTaskStatus) => {
    setTasks(await updateRevisionTaskStatus(novelId, taskId, status))
  }

  const handleDeleteTask = async (taskId: string) => {
    setTasks(await deleteRevisionTask(novelId, taskId))
  }

  const handleJump = async (targetChapterId: string) => {
    const chapter = await chapterService.getById(targetChapterId)
    if (!chapter) {
      flash('目标章节不存在')
      return
    }
    selectChapter(chapter)
    setSelectedVolumeId(chapter.volumeId)
    setEditorDrawer(null)
  }

  const visibleTasks = useMemo(
    () => (taskFilter === 'all' ? tasks : tasks.filter((t) => t.status === taskFilter)),
    [tasks, taskFilter]
  )

  const impactByChapter = useMemo(() => {
    const map = new Map<string, ImpactReport['hits']>()
    for (const hit of impact?.hits ?? []) {
      const list = map.get(hit.chapterId) ?? []
      list.push(hit)
      map.set(hit.chapterId, list)
    }
    return Array.from(map.entries())
  }, [impact])

  if (!selectedChapter) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-xs text-muted-foreground/60 leading-relaxed">
        先在左侧选择一个章节，再进行改稿对比。
      </div>
    )
  }

  return (
    <>
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/20">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'px-2 py-1 rounded text-[11px] transition-colors',
              tab === t.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[130px]" title={selectedChapter.title}>
          {selectedChapter.title}
        </span>
      </div>

      {msg && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-muted/30 text-[11px] text-foreground">{msg}</div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {tab === 'diff' && (
          <DiffTab
            snapshots={snapshots}
            snapshotName={snapshotName}
            onSnapshotChange={setSnapshotName}
            onSnapshotNow={handleSnapshotNow}
            onCompare={handleCompare}
            loading={diffLoading}
            applying={applying}
            diff={diff}
            accepted={accepted}
            onToggle={toggleSegment}
            onAdoptAll={() => setAllChanges(true)}
            onRejectAll={() => setAllChanges(false)}
            onApply={handleApply}
          />
        )}

        {tab === 'impact' && (
          <ImpactTab
            entities={entities}
            keyword={keyword}
            onKeywordChange={setKeyword}
            onAddKeyword={addKeyword}
            onRemoveEntity={(name) => setEntities((prev) => prev.filter((e) => e.name !== name))}
            onAnalyze={handleAnalyze}
            loading={impactLoading}
            impact={impact}
            impactByChapter={impactByChapter}
            onAddCascadeTask={handleAddCascadeTask}
            onCascade={handleCascade}
            cascadeLoading={cascadeLoading}
            cascade={cascade}
          />
        )}

        {tab === 'tasks' && (
          <TasksTab
            tasks={visibleTasks}
            filter={taskFilter}
            onFilterChange={setTaskFilter}
            refs={refs}
            currentChapterId={chapterId}
            taskTitle={taskTitle}
            taskTarget={taskTarget}
            onTargetChange={setTaskTarget}
            taskType={taskType}
            onTypeChange={setTaskType}
            taskDesc={taskDesc}
            onDescChange={setTaskDesc}
            onCreate={handleCreateTask}
            onStatus={handleStatus}
            onDelete={handleDeleteTask}
            onJump={handleJump}
          />
        )}
      </div>
    </>
  )
}

// ===== 版本对比 =====

function DiffTab(props: {
  snapshots: SnapshotMeta[]
  snapshotName: string
  onSnapshotChange: (name: string) => void
  onSnapshotNow: () => void
  onCompare: () => void
  loading: boolean
  applying: boolean
  diff: DiffResult | null
  accepted: Record<string, boolean>
  onToggle: (key: string) => void
  onAdoptAll: () => void
  onRejectAll: () => void
  onApply: () => void
}) {
  const {
    snapshots, snapshotName, onSnapshotChange, onSnapshotNow, onCompare,
    loading, applying, diff, accepted, onToggle, onAdoptAll, onRejectAll, onApply,
  } = props

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-2">
        <div className="text-[11px] text-muted-foreground">选择一份历史版本，与当前正文逐段对比</div>
        {snapshots.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/70 leading-relaxed">
            还没有历史版本。
            <button onClick={onSnapshotNow} className="ml-1 text-primary hover:underline">
              先留一份当前版本
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <select
              value={snapshotName}
              onChange={(e) => onSnapshotChange(e.target.value)}
              className="flex-1 min-w-0 bg-background border border-border/40 rounded px-2 py-1 text-[11px] text-foreground"
            >
              {snapshots.map((meta) => (
                <option key={meta.name} value={meta.name}>
                  {formatTime(meta.ts)} · {snapshotSourceLabel(meta.source)}
                </option>
              ))}
            </select>
            <button
              onClick={onCompare}
              disabled={loading}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40"
            >
              {loading ? <Loader2 size={11} className="animate-spin" /> : <GitCompare size={11} />}
              {loading ? '对比中…' : '开始对比'}
            </button>
          </div>
        )}
      </div>

      {diff && (
        <>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="text-emerald-400">新增 {diff.summary.added} 行</span>
            <span className="text-red-400">删除 {diff.summary.removed} 行</span>
            <span>未变 {diff.summary.unchanged} 行</span>
            <div className="ml-auto flex gap-1">
              <button onClick={onAdoptAll} className="px-1.5 py-0.5 rounded bg-muted/30 hover:bg-muted/50 text-[10px]">
                全部采用
              </button>
              <button onClick={onRejectAll} className="px-1.5 py-0.5 rounded bg-muted/30 hover:bg-muted/50 text-[10px]">
                全部撤回
              </button>
            </div>
          </div>

          <div className="space-y-1">
            {diff.segments.map((seg) => (
              <DiffBlock
                key={seg.key}
                segment={seg}
                adopted={accepted[seg.key] ?? true}
                onToggle={() => onToggle(seg.key)}
              />
            ))}
          </div>

          <button
            onClick={onApply}
            disabled={applying}
            className={cn(
              'w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors',
              'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40'
            )}
          >
            {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {applying ? '应用中…' : '应用改动'}
          </button>
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed text-center">
            应用前会自动留一份当前版本，可在「历史版本」中恢复。
          </p>
        </>
      )}
    </div>
  )
}

function DiffBlock({ segment, adopted, onToggle }: {
  segment: DiffResult['segments'][number]
  adopted: boolean
  onToggle: () => void
}) {
  if (segment.kind === 'equal') {
    const lines = segment.lines
    const head = lines.slice(0, 2)
    const tail = lines.length > 4 ? lines.slice(-2) : []
    return (
      <div className="rounded border border-border/10 bg-muted/5 px-2 py-1.5">
        {head.map((line, i) => (
          <div key={i} className="text-[11px] text-muted-foreground/70 whitespace-pre-wrap leading-relaxed">{line || ' '}</div>
        ))}
        {lines.length > 4 && (
          <div className="text-[10px] text-muted-foreground/50 py-0.5">… {lines.length - 4} 行未改动 …</div>
        )}
        {tail.map((line, i) => (
          <div key={`t${i}`} className="text-[11px] text-muted-foreground/70 whitespace-pre-wrap leading-relaxed">{line || ' '}</div>
        ))}
      </div>
    )
  }

  const added = segment.kind === 'added'
  const effective = added ? adopted : !adopted
  return (
    <div
      className={cn(
        'rounded border px-2 py-1.5',
        effective
          ? added ? 'border-emerald-500/25 bg-emerald-500/10' : 'border-red-500/25 bg-red-500/10'
          : 'border-border/20 bg-muted/10 opacity-70'
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className={cn('px-1 rounded', added ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
          {added ? '新增' : '删除'} {segment.lines.length} 行
        </span>
        <span>原第 {segment.oldStart} 行 / 新第 {segment.newStart} 行</span>
        <button
          onClick={onToggle}
          className={cn(
            'ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors',
            adopted ? 'bg-primary/15 text-primary hover:bg-primary/25' : 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
          )}
        >
          {adopted ? <Check size={10} /> : <X size={10} />}
          {adopted ? '已采用' : '已撤回'}
        </button>
      </div>
      <div className="mt-1 space-y-0.5">
        {segment.lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              'text-[11px] whitespace-pre-wrap leading-relaxed',
              added ? 'text-emerald-300' : 'text-red-300',
              (added && !adopted) || (!added && adopted) ? 'line-through opacity-60' : ''
            )}
          >
            <span className="select-none mr-1">{added ? '+' : '-'}</span>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== 影响分析 =====

function ImpactTab(props: {
  entities: ImpactEntity[]
  keyword: string
  onKeywordChange: (value: string) => void
  onAddKeyword: () => void
  onRemoveEntity: (name: string) => void
  onAnalyze: () => void
  loading: boolean
  impact: ImpactReport | null
  impactByChapter: [string, ImpactReport['hits']][]
  onAddCascadeTask: (hit: ImpactReport['hits'][number]) => void
  onCascade: () => void
  cascadeLoading: boolean
  cascade: CascadeReport | null
}) {
  const {
    entities, keyword, onKeywordChange, onAddKeyword, onRemoveEntity,
    onAnalyze, loading, impact, impactByChapter, onAddCascadeTask,
    onCascade, cascadeLoading, cascade,
  } = props

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-2">
        <div className="text-[11px] text-muted-foreground">
          从本次改动中找出角色 / 物品等实体，检查后续章节是否仍提及。
        </div>
        <div className="flex flex-wrap gap-1">
          {entities.map((entity) => (
            <span key={entity.name} className="flex items-center gap-0.5 rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-foreground/80">
              {entity.name}
              <button onClick={() => onRemoveEntity(entity.name)} className="text-muted-foreground hover:text-foreground">
                <X size={9} />
              </button>
            </span>
          ))}
          {entities.length === 0 && (
            <span className="text-[10px] text-muted-foreground/60">还没有实体，分析时会自动识别</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAddKeyword() }}
            placeholder="补充关键词（角色名 / 地点 / 物品）"
            className="flex-1 min-w-0 bg-background border border-border/40 rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50"
          />
          <button onClick={onAddKeyword} className="p-1 rounded bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground">
            <Plus size={11} />
          </button>
          <button
            onClick={onAnalyze}
            disabled={loading}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40"
          >
            {loading ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
            {loading ? '分析中…' : '分析影响'}
          </button>
        </div>
      </div>

      {impact && (
        <>
          <div className="text-[11px] text-muted-foreground">
            扫描后续 {impact.scannedChapters} 章，命中 {impact.hits.length} 处
            <span className="ml-1 text-muted-foreground/60">· 命中只作提示，不会自动改后续章</span>
          </div>

          {impact.hits.length === 0 && (
            <div className="text-center text-[11px] text-muted-foreground/60 py-6">后续章节没有命中这些实体。</div>
          )}

          <div className="space-y-2">
            {impactByChapter.map(([chapterId, hits]) => (
              <div key={chapterId} className="rounded-lg border border-border/20 bg-muted/10 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-foreground">{hits[0].chapterTitle}</span>
                  <span className="text-[10px] text-muted-foreground">第 {hits[0].chapterOrder} 章 · {hits[0].volumeTitle}</span>
                  <button
                    onClick={onCascade}
                    className="ml-auto px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 text-[10px]"
                  >
                    跑级联检查
                  </button>
                </div>
                <div className="mt-1.5 space-y-1.5">
                  {hits.map((hit, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span className="mt-0.5 rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-muted-foreground flex-shrink-0">
                        {hit.entity}
                      </span>
                      <span className="flex-1 min-w-0 text-[11px] text-foreground/85 leading-relaxed">{hit.sentence}</span>
                      <button
                        onClick={() => onAddCascadeTask(hit)}
                        className="flex-shrink-0 text-[10px] text-primary hover:underline"
                      >
                        加入清单
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {impact.hits.length > 0 && (
            <button
              onClick={onCascade}
              disabled={cascadeLoading}
              className="w-full flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-[11px] bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 disabled:opacity-40"
            >
              {cascadeLoading ? <Loader2 size={11} className="animate-spin" /> : <ShieldAlert size={11} />}
              {cascadeLoading ? '检查中…' : '对命中章跑级联检查'}
            </button>
          )}

          {cascade && (
            <div className="rounded-lg border border-border/20 bg-muted/10 p-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <ListChecks size={11} className="text-muted-foreground" />
                <span className="text-[11px] font-medium text-foreground">级联检查结果</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  硬伤 {cascade.blocking} · 提示 {cascade.warnings}
                </span>
              </div>
              {cascade.chapters.length === 0 && (
                <div className="text-[11px] text-muted-foreground/60">命中章节没有可检查的正文。</div>
              )}
              {cascade.chapters.map((chapter) => (
                <div key={chapter.chapterId} className="rounded bg-background/40 px-2 py-1.5">
                  <div className="text-[11px] text-foreground/85">{chapter.chapterTitle}</div>
                  {chapter.findings.length === 0 ? (
                    <div className="text-[10px] text-emerald-400">未发现硬伤或提示</div>
                  ) : (
                    chapter.findings.map((finding, i) => (
                      <div key={i} className="mt-1 flex items-start gap-1">
                        <span className={cn(
                          'mt-0.5 rounded px-1 py-0.5 text-[9px] flex-shrink-0',
                          finding.severity === 'blocking' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
                        )}>
                          {finding.severity === 'blocking' ? '硬伤' : '提示'}
                        </span>
                        <span className="text-[10px] text-foreground/80 leading-relaxed">{finding.message}</span>
                      </div>
                    ))
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ===== 修订任务 =====

function TasksTab(props: {
  tasks: RevisionTask[]
  filter: 'all' | RevisionTaskStatus
  onFilterChange: (value: 'all' | RevisionTaskStatus) => void
  refs: NovelChapterRef[]
  currentChapterId: string
  taskTitle: (id: string) => string
  taskTarget: string
  onTargetChange: (value: string) => void
  taskType: RevisionTaskType
  onTypeChange: (value: RevisionTaskType) => void
  taskDesc: string
  onDescChange: (value: string) => void
  onCreate: () => void
  onStatus: (taskId: string, status: RevisionTaskStatus) => void
  onDelete: (taskId: string) => void
  onJump: (chapterId: string) => void
}) {
  const {
    tasks, filter, onFilterChange, refs, currentChapterId, taskTitle,
    taskTarget, onTargetChange, taskType, onTypeChange, taskDesc, onDescChange,
    onCreate, onStatus, onDelete, onJump,
  } = props

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/30 bg-muted/10 p-2.5 space-y-2">
        <div className="text-[11px] text-muted-foreground">新建一条修订任务，后续按清单逐章处理</div>
        <div className="flex items-center gap-1.5">
          <select
            value={taskTarget}
            onChange={(e) => onTargetChange(e.target.value)}
            className="flex-1 min-w-0 bg-background border border-border/40 rounded px-2 py-1 text-[11px] text-foreground"
          >
            <option value="">选择目标章</option>
            {refs.filter((r) => r.chapter.id !== currentChapterId).map((r) => (
              <option key={r.chapter.id} value={r.chapter.id}>{r.chapter.title}</option>
            ))}
          </select>
          <select
            value={taskType}
            onChange={(e) => onTypeChange(e.target.value as RevisionTaskType)}
            className="bg-background border border-border/40 rounded px-2 py-1 text-[11px] text-foreground"
          >
            {TASK_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>{REVISION_TASK_TYPE_LABEL[type]}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={taskDesc}
            onChange={(e) => onDescChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onCreate() }}
            placeholder="说明要检查或修改什么"
            className="flex-1 min-w-0 bg-background border border-border/40 rounded px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50"
          />
          <button
            onClick={onCreate}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25"
          >
            <Plus size={11} />
            新建任务
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {TASK_FILTERS.map((item) => (
          <button
            key={item.id}
            onClick={() => onFilterChange(item.id)}
            className={cn(
              'px-1.5 py-0.5 rounded text-[10px] transition-colors',
              filter === item.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">{tasks.length} 条</span>
      </div>

      {tasks.length === 0 && (
        <div className="text-center text-[11px] text-muted-foreground/60 py-8">
          当前筛选下没有任务。
          <br />
          影响分析里的「加入清单」也会落到这里。
        </div>
      )}

      <div className="space-y-1.5">
        {tasks.map((task) => (
          <div key={task.id} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className={cn(
                'rounded px-1.5 py-0.5 text-[9px]',
                task.status === 'done' ? 'bg-emerald-500/15 text-emerald-400'
                  : task.status === 'ignored' ? 'bg-muted/40 text-muted-foreground'
                    : 'bg-amber-500/15 text-amber-400'
              )}>
                {REVISION_TASK_STATUS_LABEL[task.status]}
              </span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {REVISION_TASK_TYPE_LABEL[task.type]}
              </span>
              <button
                onClick={() => onJump(task.targetChapterId)}
                className="ml-auto flex items-center gap-0.5 text-[10px] text-primary hover:underline"
              >
                {taskTitle(task.targetChapterId)}
                <ArrowRight size={9} />
              </button>
            </div>
            <div className="mt-1 text-[11px] text-foreground/85 leading-relaxed">{task.description || '（无说明）'}</div>
            <div className="mt-1.5 flex items-center gap-1">
              {task.status !== 'done' && (
                <button onClick={() => onStatus(task.id, 'done')} className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-[10px]">
                  标记完成
                </button>
              )}
              {task.status !== 'ignored' && (
                <button onClick={() => onStatus(task.id, 'ignored')} className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground hover:bg-muted/50 text-[10px]">
                  忽略
                </button>
              )}
              {task.status !== 'open' && (
                <button onClick={() => onStatus(task.id, 'open')} className="px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground hover:bg-muted/50 text-[10px]">
                  重新打开
                </button>
              )}
              <button onClick={() => onDelete(task.id)} className="ml-auto p-0.5 text-muted-foreground hover:text-red-400">
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
