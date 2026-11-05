import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Cloud,
  Loader2,
  Menu,
  PanelRightOpen,
  Sparkles,
  X,
} from 'lucide-react'
import TitleBar from '@/components/layout/TitleBar'
import PlanTree from '@/components/plan/PlanTree'
import PlanEditor from '@/components/plan/PlanEditor'
import PlanAiPanel from '@/components/plan/PlanAiPanel'
import {
  allChapters,
  checklistPercent,
  computePlanChecklist,
  emptySeedForm,
  isPlanReady,
  missingHooksCount,
  seedFormFrom,
  type PlanMode,
  type PlanSelection,
  type SeedForm,
} from '@/components/plan/plan-utils'
import { collectVolumes } from '@/services/ai-outline'
import {
  chapterService,
  characterService,
  novelService,
  volumeService,
} from '@/services/data-service'
import { knowledgeService } from '@/services/knowledge-service'
import type { Chapter, Character, Novel, Volume } from '@shared/types'
import type { VolChap } from '@/services/ai-outline'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const draftKey = (novelId: string) => `zx-plan-draft:${novelId}`

const loadSeedDraft = (novelId: string): string => {
  try {
    return window.localStorage.getItem(draftKey(novelId)) ?? ''
  } catch {
    return ''
  }
}

interface PendingSave {
  kind: 'novel' | 'volume' | 'chapter'
  id: string
  patch: Record<string, unknown>
  timer: number
}

export default function PlanPage() {
  const { novelId } = useParams<{ novelId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const from = searchParams.get('from')
  const initialChapterId = searchParams.get('chapterId')

  const [novel, setNovel] = useState<Novel | null>(null)
  const [vols, setVols] = useState<VolChap[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [seedForm, setSeedForm] = useState<SeedForm>(emptySeedForm)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selection, setSelection] = useState<PlanSelection>({ kind: 'master' })
  const [aiMode, setAiMode] = useState<PlanMode>('seed')
  const [treeOpen, setTreeOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [toast, setToast] = useState<{ message: string; kind: 'ok' | 'error' } | null>(null)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [confirmWrite, setConfirmWrite] = useState(false)

  const pendingRef = useRef(new Map<string, PendingSave>())
  const outlineTimer = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const initSelectionDone = useRef(false)
  const initModeDone = useRef(false)
  const initSeedFormDone = useRef(false)

  // 立项素材预填一次：之后由作者编辑，不随自动保存回写覆盖
  useEffect(() => {
    if (!novel || initSeedFormDone.current) return
    initSeedFormDone.current = true
    setSeedForm({ ...seedFormFrom(novel, characters), draft: loadSeedDraft(novel.id) })
  }, [novel, characters])

  // 草稿区只存在本地，按作品隔离；关掉页面再回来仍能看到
  useEffect(() => {
    if (!novelId || !initSeedFormDone.current) return
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey(novelId), seedForm.draft)
      } catch {
        // 本地存储不可用时静默跳过，草稿仍保留在本次会话内存中
      }
    }, 400)
    return () => window.clearTimeout(timer)
  }, [novelId, seedForm.draft])

  const showToast = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ message, kind })
    window.setTimeout(() => setToast((cur) => (cur?.message === message ? null : cur)), 2600)
  }, [])

  const patchSeedForm = useCallback((patch: Partial<SeedForm>) => {
    setSeedForm((prev) => ({ ...prev, ...patch }))
  }, [])

  const reload = useCallback(async () => {
    if (!novelId) return
    try {
      const n = await novelService.getById(novelId)
      if (!n) {
        setLoadError('未找到该小说')
        setLoading(false)
        return
      }
      const [v, c] = await Promise.all([
        collectVolumes(novelId),
        characterService.getByNovelId(novelId),
      ])
      setNovel(n)
      setVols(v)
      setCharacters(c)
      setLoadError(null)
      setLoading(false)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [novelId])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingRef.current.forEach((p) => window.clearTimeout(p.timer))
      pendingRef.current.clear()
      if (outlineTimer.current) window.clearTimeout(outlineTimer.current)
    }
  }, [])

  // 首次加载后：优先定位查询参数里的章节，否则停留主线
  useEffect(() => {
    if (loading || initSelectionDone.current) return
    initSelectionDone.current = true
    if (!initialChapterId) return
    for (const v of vols) {
      const ch = v.chapters.find((c) => c.id === initialChapterId)
      if (ch) {
        setSelection({ kind: 'chapter', volumeId: v.vol.id, chapterId: ch.id })
        return
      }
    }
  }, [loading, vols, initialChapterId])

  // 首次加载后按现状选择默认 AI 模式
  useEffect(() => {
    if (loading || initModeDone.current) return
    initModeDone.current = true
    const chapters = allChapters(vols)
    if (vols.length === 0) setAiMode('seed')
    else if (chapters.length === 0) setAiMode('volume-chapters')
    else if (selection.kind === 'chapter') setAiMode('chapter-detail')
    else setAiMode('volume-chapters')
  }, [loading, vols, selection])

  const scheduleOutlineSync = useCallback(() => {
    if (!novelId) return
    if (outlineTimer.current) window.clearTimeout(outlineTimer.current)
    outlineTimer.current = window.setTimeout(() => {
      knowledgeService.syncOutline(novelId).catch((e) => {
        console.warn('[PlanPage] sync outline failed:', e)
      })
    }, 1200)
  }, [novelId])

  const executeSave = useCallback(
    async (pending: PendingSave) => {
      if (!novelId) return
      setSaveState('saving')
      try {
        if (pending.kind === 'novel') {
          await novelService.update(novelId, pending.patch as Partial<Novel>)
        } else if (pending.kind === 'volume') {
          await volumeService.update(pending.id, pending.patch as Partial<Volume>)
        } else {
          const patch = { ...pending.patch } as Partial<Chapter>
          if (Array.isArray(patch.hooks)) {
            patch.hooks = patch.hooks.map((h) => String(h).trim()).filter(Boolean)
          }
          await chapterService.update(pending.id, patch)
        }
        if (mountedRef.current) {
          setSaveState(pendingRef.current.size > 0 ? 'saving' : 'saved')
          setSaveError('')
        }
        scheduleOutlineSync()
      } catch (e) {
        if (mountedRef.current) {
          setSaveState('error')
          setSaveError(e instanceof Error ? e.message : String(e))
        }
      }
    },
    [novelId, scheduleOutlineSync],
  )

  const queueSave = useCallback(
    (kind: PendingSave['kind'], id: string, patch: Record<string, unknown>) => {
      const key = `${kind}:${id}`
      const current = pendingRef.current.get(key)
      if (current) window.clearTimeout(current.timer)
      const merged = { ...(current?.patch ?? {}), ...patch }
      const timer = window.setTimeout(() => {
        const p = pendingRef.current.get(key)
        if (!p) return
        pendingRef.current.delete(key)
        void executeSave(p)
      }, 600)
      pendingRef.current.set(key, { kind, id, patch: merged, timer })
      setSaveState('saving')
    },
    [executeSave],
  )

  const flushAll = useCallback(async () => {
    const list = [...pendingRef.current.values()]
    pendingRef.current.clear()
    if (list.length === 0) return
    await Promise.all(
      list.map((p) => {
        window.clearTimeout(p.timer)
        return executeSave(p)
      }),
    )
  }, [executeSave])

  const handleNovelChange = (patch: Partial<Novel>) => {
    setNovel((prev) => (prev ? { ...prev, ...patch } : prev))
    if (novelId) queueSave('novel', novelId, patch as Record<string, unknown>)
  }

  const handleVolumeChange = (volumeId: string, patch: Partial<Volume>) => {
    setVols((prev) =>
      prev.map((v) => (v.vol.id === volumeId ? { ...v, vol: { ...v.vol, ...patch } } : v)),
    )
    queueSave('volume', volumeId, patch as Record<string, unknown>)
  }

  const handleChapterChange = (chapterId: string, patch: Partial<Chapter>) => {
    setVols((prev) =>
      prev.map((v) => ({
        ...v,
        chapters: v.chapters.map((c) => (c.id === chapterId ? { ...c, ...patch } : c)),
      })),
    )
    queueSave('chapter', chapterId, patch as Record<string, unknown>)
  }

  const selectNode = (next: PlanSelection) => {
    flushAll()
    setSelection(next)
    setTreeOpen(false)
  }

  const addVolume = async () => {
    if (!novelId) return
    const order = vols.reduce((m, v) => Math.max(m, v.vol.order || 0), 0) + 1
    const id = crypto.randomUUID()
    await volumeService.create({ id, novelId, title: `第${order}卷`, order, summary: '' })
    const fresh = await collectVolumes(novelId)
    setVols(fresh)
    setSelection({ kind: 'volume', volumeId: id })
    showToast('已新建卷')
  }

  const addChapter = async (volumeId: string) => {
    if (!novelId) return
    const vol = vols.find((v) => v.vol.id === volumeId)
    if (!vol) return
    const order = vol.chapters.reduce((m, c) => Math.max(m, c.order || 0), 0) + 1
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await chapterService.create({
      id,
      volumeId,
      title: `第${order}章`,
      order,
      contentPath: `content/${novelId}/${crypto.randomUUID()}.md`,
      wordCount: 0,
      status: 'draft',
      targetWordCount: 3000,
      hooks: [],
      summary: '',
      createdAt: now,
      updatedAt: now,
    })
    const fresh = await collectVolumes(novelId)
    setVols(fresh)
    setSelection({ kind: 'chapter', volumeId, chapterId: id })
    showToast('已添加章节')
  }

  const deleteVolume = async (volumeId: string) => {
    const vol = vols.find((v) => v.vol.id === volumeId)
    if (!vol || !novelId) return
    const written = vol.chapters.filter((c) => c.wordCount > 0).length
    const message =
      written > 0
        ? `《${vol.vol.title}》内有 ${written} 章已有正文，删除会连同正文一起移除，确定？`
        : `删除《${vol.vol.title}》及本卷 ${vol.chapters.length} 章？`
    if (!window.confirm(message)) return
    flushAll()
    await volumeService.delete(volumeId)
    const fresh = await collectVolumes(novelId)
    setVols(fresh)
    setSelection({ kind: 'master' })
    showToast('已删除卷')
  }

  const deleteChapter = async (chapterId: string) => {
    if (!novelId) return
    const found = allChapters(vols).find((c) => c.id === chapterId)
    if (!found) return
    const message =
      found.wordCount > 0 ? `《${found.title}》已有正文，删除会移除正文，确定？` : `删除《${found.title}》？`
    if (!window.confirm(message)) return
    flushAll()
    await chapterService.delete(chapterId)
    const fresh = await collectVolumes(novelId)
    setVols(fresh)
    setSelection({ kind: 'master' })
    showToast('已删除章节')
  }

  const moveVolume = async (volumeId: string, targetIndex: number) => {
    if (!novelId) return
    const ordered = [...vols].sort((a, b) => a.vol.order - b.vol.order)
    const fromIndex = ordered.findIndex((v) => v.vol.id === volumeId)
    if (fromIndex < 0) return
    const [item] = ordered.splice(fromIndex, 1)
    ordered.splice(Math.max(0, Math.min(targetIndex, ordered.length)), 0, item)
    await Promise.all(
      ordered.map((v, i) =>
        v.vol.order === i + 1 ? Promise.resolve() : volumeService.updateOrder(v.vol.id, i + 1),
      ),
    )
    setVols(ordered.map((v, i) => ({ ...v, vol: { ...v.vol, order: i + 1 } })))
    scheduleOutlineSync()
  }

  const moveChapter = async (
    chapterId: string,
    targetVolumeId: string,
    targetIndex: number,
  ) => {
    if (!novelId) return
    const source = vols.find((v) => v.chapters.some((c) => c.id === chapterId))
    const target = vols.find((v) => v.vol.id === targetVolumeId)
    if (!source || !target) return
    const moved = source.chapters.find((c) => c.id === chapterId)
    if (!moved) return
    const sameVolume = source.vol.id === target.vol.id
    const sourceList = source.chapters.filter((c) => c.id !== chapterId)
    const targetList = sameVolume
      ? sourceList
      : target.chapters.filter((c) => c.id !== chapterId)
    targetList.splice(Math.max(0, Math.min(targetIndex, targetList.length)), 0, {
      ...moved,
      volumeId: targetVolumeId,
    })
    if (!sameVolume) await chapterService.setVolume(chapterId, targetVolumeId)
    await Promise.all(
      targetList.map((c, i) => (c.order === i + 1 ? Promise.resolve() : chapterService.update(c.id, { order: i + 1 }))),
    )
    if (!sameVolume) {
      await Promise.all(
        sourceList.map((c, i) =>
          c.order === i + 1 ? Promise.resolve() : chapterService.update(c.id, { order: i + 1 }),
        ),
      )
    }
    const fresh = await collectVolumes(novelId)
    setVols(fresh)
    scheduleOutlineSync()
  }

  const retrySave = () => {
    if (!novel) return
    setSaveState('saving')
    setSaveError('')
    const run = async () => {
      try {
        await novelService.update(novel.id, { masterOutline: novel.masterOutline ?? '' })
        if (selection.kind !== 'master') {
          const vol = vols.find((v) => v.vol.id === selection.volumeId)
          if (vol) {
            await volumeService.update(vol.vol.id, {
              title: vol.vol.title,
              summary: vol.vol.summary,
              goal: vol.vol.goal,
              climax: vol.vol.climax,
              endingHook: vol.vol.endingHook,
              estimatedChapters: vol.vol.estimatedChapters,
              targetWordCount: vol.vol.targetWordCount,
            })
            if (selection.kind === 'chapter') {
              const ch = vol.chapters.find((c) => c.id === selection.chapterId)
              if (ch) {
                await chapterService.update(ch.id, {
                  title: ch.title,
                  summary: ch.summary,
                  hooks: ch.hooks,
                  targetWordCount: ch.targetWordCount,
                  status: ch.status,
                })
              }
            }
          }
        }
        await knowledgeService.syncOutline(novel.id)
        setSaveState('saved')
      } catch (e) {
        setSaveState('error')
        setSaveError(e instanceof Error ? e.message : String(e))
      }
    }
    void run()
  }

  const checklist = useMemo(
    () => computePlanChecklist(novel, vols, characters),
    [novel, vols, characters],
  )
  const percent = checklistPercent(checklist)
  const ready = isPlanReady(checklist)
  const chapters = allChapters(vols)
  const writtenCount = chapters.filter((c) => c.wordCount > 0).length
  const missingHooks = missingHooksCount(vols)
  const statusLabel = writtenCount > 0 ? '写作中' : ready ? '可开写' : '待规划'

  const goBack = () => {
    flushAll()
    if (from === 'workbench' && novelId) navigate(`/workbench/${novelId}`)
    else navigate('/')
  }

  const enterWriting = () => {
    if (!novelId) return
    if (!ready && writtenCount === 0 && !confirmWrite) {
      setConfirmWrite(true)
      showToast('规划尚未完成，再点一次确认进入写作', 'error')
      window.setTimeout(() => setConfirmWrite(false), 3200)
      return
    }
    flushAll()
    navigate(`/workbench/${novelId}`)
  }

  const openAi = (mode: PlanMode) => {
    flushAll()
    setAiMode(mode)
    setAiOpen(true)
  }

  if (!novelId) {
    return (
      <div className="flex h-screen flex-col bg-background">
        <TitleBar />
        <div className="flex flex-1 items-center justify-center pt-9 text-sm text-muted-foreground">
          缺少作品参数
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <TitleBar />

      {/* Top bar */}
      <div className="mt-9 flex h-11 flex-shrink-0 items-center gap-2 border-b border-border/40 bg-sidebar px-2.5 no-drag select-none">
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          返回
        </button>
        <span className="text-border/30">|</span>
        <button
          onClick={() => {
            flushAll()
            navigate('/')
          }}
          className="max-w-[220px] truncate text-xs font-medium text-foreground hover:text-primary"
          title="回首页编辑小说信息"
        >
          {novel?.title ?? '加载中…'}
        </button>
        {!!novel?.genre?.length && (
          <span className="hidden items-center gap-1 sm:flex">
            {novel.genre.slice(0, 2).map((g) => (
              <span key={g} className="rounded bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                {g}
              </span>
            ))}
          </span>
        )}
        <span
          className={cn(
            'ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px]',
            writtenCount > 0
              ? 'bg-emerald-500/10 text-emerald-300'
              : ready
                ? 'bg-sky-500/10 text-sky-300'
                : 'bg-amber-500/10 text-amber-300',
          )}
        >
          <span
            className={cn(
              'h-1 w-1 rounded-full',
              writtenCount > 0 ? 'bg-emerald-400' : ready ? 'bg-sky-400' : 'bg-amber-400',
            )}
          />
          {statusLabel}
        </span>

        <button
          onClick={() => setTreeOpen(true)}
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted/30 hover:text-foreground lg:hidden"
          title="结构树"
        >
          <Menu size={14} />
        </button>

        <div className="flex-1" />

        {/* Save state */}
        <div className="hidden items-center gap-1 text-[10px] text-muted-foreground sm:flex">
          {saveState === 'saving' ? (
            <>
              <Loader2 size={10} className="animate-spin" /> 保存中
            </>
          ) : saveState === 'saved' ? (
            <>
              <Check size={10} className="text-emerald-400" /> 已保存
            </>
          ) : saveState === 'error' ? (
            <>
              <AlertTriangle size={10} className="text-red-400" />
              <span className="text-red-400">保存失败</span>
              <button onClick={retrySave} className="text-red-300 underline underline-offset-2">
                重试
              </button>
            </>
          ) : (
            <>
              <Cloud size={10} /> 自动保存
            </>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setChecklistOpen((v) => !v)}
            className="flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
            title="完成度检查清单"
          >
            <CheckCircle2 size={11} className={ready ? 'text-emerald-400' : 'text-muted-foreground'} />
            {percent}%
          </button>
          {checklistOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setChecklistOpen(false)} />
              <div className="absolute right-0 top-9 z-50 w-64 rounded-lg border border-border/60 bg-popover p-3 shadow-xl animate-scale-in">
                <p className="text-[11px] font-medium text-foreground">开写检查清单</p>
                <div className="mt-2 space-y-1.5">
                  {checklist.map((item) => (
                    <div key={item.key} className="flex items-start gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          'mt-0.5 flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-full',
                          item.done ? 'bg-emerald-500/20 text-emerald-400' : 'bg-muted/50 text-muted-foreground/50',
                        )}
                      >
                        {item.done ? <Check size={8} /> : <span className="h-1 w-1 rounded-full bg-current" />}
                      </span>
                      <span className={item.done ? 'text-foreground/80' : 'text-muted-foreground'}>
                        {item.label}
                        {item.hint && <span className="ml-1 text-amber-400/80">· {item.hint}</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 border-t border-border/40 pt-1.5 text-[9px] leading-relaxed text-muted-foreground/70">
                  未写章缺少细纲时，流水线无法开写对应章节。
                </p>
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => setAiOpen(true)}
          className="rounded p-1 text-violet-300 hover:bg-violet-500/15 xl:hidden"
          title="AI 规划"
        >
          <Sparkles size={14} />
        </button>

        <Button
          size="sm"
          className={cn('h-7 px-2.5 text-[11px]', confirmWrite && 'bg-amber-600 hover:bg-amber-500')}
          onClick={enterWriting}
        >
          {confirmWrite ? '再点一次确认进入' : '进入写作'}
        </Button>
      </div>

      {saveState === 'error' && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-red-500/25 bg-red-500/10 px-3 py-1 text-[10px] text-red-300">
          <AlertTriangle size={11} />
          <span className="flex-1 truncate">保存失败：{saveError}</span>
          <button onClick={retrySave} className="rounded bg-red-500/20 px-2 py-0.5 hover:bg-red-500/30">
            重试
          </button>
        </div>
      )}

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <aside
          className={cn(
            'w-[260px] flex-shrink-0 border-r border-border/40 bg-sidebar/40',
            'hidden lg:flex',
            treeOpen && 'fixed bottom-0 left-0 top-9 z-40 flex w-[280px] max-w-[86vw] flex-col bg-sidebar shadow-2xl',
          )}
        >
          <div className="flex items-center justify-between border-b border-border/40 px-2 py-1 lg:hidden">
            <span className="text-[10px] text-muted-foreground">结构树</span>
            <button onClick={() => setTreeOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted/40">
              <X size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <PlanTree
              vols={vols}
              selection={selection}
              masterOutlineEmpty={!novel?.masterOutline?.trim()}
              onSelect={selectNode}
              onAddVolume={() => void addVolume()}
              onAddChapter={(volumeId) => void addChapter(volumeId)}
              onDeleteVolume={(volumeId) => void deleteVolume(volumeId)}
              onDeleteChapter={(chapterId) => void deleteChapter(chapterId)}
              onMoveVolume={(volumeId, index) => void moveVolume(volumeId, index)}
              onMoveChapter={(chapterId, volumeId, index) => void moveChapter(chapterId, volumeId, index)}
              onAiForVolume={(volumeId) => {
                selectNode({ kind: 'volume', volumeId })
                openAi('volume-chapters')
              }}
              onAiForChapter={(volumeId, chapterId) => {
                selectNode({ kind: 'chapter', volumeId, chapterId })
                openAi('chapter-detail')
              }}
            />
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <Loader2 size={14} className="mr-2 animate-spin" /> 正在读取规划数据…
            </div>
          ) : loadError || !novel ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-sm text-muted-foreground">{loadError || '未找到该小说'}</p>
              <Button size="sm" variant="outline" onClick={goBack}>
                返回
              </Button>
            </div>
          ) : (
            <PlanEditor
              novel={novel}
              vols={vols}
              characters={characters}
              selection={selection}
              seedForm={seedForm}
              onSeedFormChange={patchSeedForm}
              onNovelChange={handleNovelChange}
              onVolumeChange={handleVolumeChange}
              onChapterChange={handleChapterChange}
              onAddVolume={() => void addVolume()}
              onAddChapter={(volumeId) => void addChapter(volumeId)}
              onSelect={selectNode}
              onOpenAi={openAi}
              onHome={() => {
                flushAll()
                navigate('/')
              }}
            />
          )}
        </main>

        <aside
          className={cn(
            'w-[400px] flex-shrink-0 border-l border-border/40 bg-sidebar/30',
            'hidden xl:flex',
            aiOpen && 'fixed bottom-0 right-0 top-9 z-40 flex w-[380px] max-w-[92vw] flex-col bg-sidebar shadow-2xl',
          )}
        >
          <div className="flex items-center justify-end border-b border-border/40 px-2 py-1 xl:hidden">
            <button onClick={() => setAiOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-muted/40">
              <X size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {novel && (
              <PlanAiPanel
                novelId={novelId}
                novel={novel}
                vols={vols}
                characters={characters}
                seedForm={seedForm}
                onSeedFormChange={patchSeedForm}
                selection={selection}
                mode={aiMode}
                onModeChange={setAiMode}
                onApplied={reload}
                onBeforeAdopt={flushAll}
                onSelect={selectNode}
                onToast={showToast}
              />
            )}
          </div>
        </aside>

        {treeOpen && (
          <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setTreeOpen(false)} />
        )}
        {aiOpen && (
          <div className="fixed inset-0 z-30 bg-black/50 xl:hidden" onClick={() => setAiOpen(false)} />
        )}
      </div>

      {/* Status bar */}
      <div className="flex h-7 flex-shrink-0 items-center gap-3 overflow-hidden border-t border-border/40 bg-sidebar/50 px-3 text-[10px] text-muted-foreground">
        <span className="whitespace-nowrap">{vols.length} 卷 · {chapters.length} 章</span>
        <span className="hidden whitespace-nowrap sm:inline">
          首卷 {vols[0]?.chapters.length ?? 0} 章已规划
        </span>
        <span className={cn('whitespace-nowrap', missingHooks > 0 && 'text-amber-400/90')}>
          {missingHooks} 章缺细纲
        </span>
        <span className="hidden whitespace-nowrap md:inline">{writtenCount} 章已写</span>
        <span className="ml-auto hidden whitespace-nowrap md:inline">
          {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存于本地'}
        </span>
      </div>

      {toast && (
        <div
          className={cn(
            'fixed bottom-10 right-4 z-50 max-w-[320px] rounded-lg border px-3 py-2 text-[11px] shadow-xl animate-scale-in',
            toast.kind === 'ok'
              ? 'border-emerald-500/30 bg-emerald-950/90 text-emerald-200'
              : 'border-amber-500/30 bg-amber-950/90 text-amber-200',
          )}
        >
          {toast.message}
        </div>
      )}

      {/* narrow-screen AI shortcut in status bar */}
      <button
        onClick={() => setAiOpen(true)}
        className="fixed bottom-9 right-3 z-20 rounded-full bg-violet-600 p-2.5 text-white shadow-lg hover:bg-violet-500 xl:hidden"
        title="AI 规划"
      >
        <PanelRightOpen size={15} />
      </button>
    </div>
  )
}
