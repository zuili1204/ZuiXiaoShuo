import { useState, useEffect, useRef } from 'react'
import { Plus, ChevronRight, BookOpen, Loader2, FileText, Wand2, Sparkles, Square, ListTree, Route } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { volumeService, chapterService } from '@/services/data-service'
import { buildOutline, refineOutline, type OutlineProgress, type BuildOutlineOptions, type RefineOutlineOptions } from '@/services/ai-outline'
import type { Volume, Chapter } from '@shared/types'

interface OutlineNode {
  id: string
  title: string
  type: 'volume' | 'chapter'
  order: number
  summary: string
  targetWordCount: number
  wordCount: number
  children?: OutlineNode[]
}

interface Props {
  novelId: string
  /** 外层（WorkbenchPage 二级滑出层）落库后自增，触发本面板重载大纲 */
  refreshSignal?: number
  /** 打开二级滑出层：新建大纲向导（携带当前章数用于提示）/ 重订走向 */
  onOpenWizard?: (existingChapters: number) => void
  onOpenRecalibrate?: () => void
}

export default function OutlinePanel({ novelId, refreshSignal = 0, onOpenWizard, onOpenRecalibrate }: Props) {
  const [outline, setOutline] = useState<OutlineNode[]>([])
  const [expandedVolumes, setExpandedVolumes] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateVol, setShowCreateVol] = useState(false)
  const [newVolTitle, setNewVolTitle] = useState('')
  const [showCreateCh, setShowCreateCh] = useState<string | null>(null) // volumeId
  const [newChTitle, setNewChTitle] = useState('')

  // AI 大纲构建/完善状态
  const [reloadKey, setReloadKey] = useState(0)
  const [buildScope, setBuildScope] = useState<'full' | 'volume' | 'chapter'>('full')
  const [refineScope, setRefineScope] = useState<'full' | 'volume' | 'chapter'>('full')
  const [aiProgress, setAiProgress] = useState<OutlineProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // D-T3-1：进度自动清除定时器统一持有，避免旧定时器误清新一次运行中的进度
  const progressTimerRef = useRef<number | null>(null)
  const [refVolStart, setRefVolStart] = useState(0)
  const [refVolEnd, setRefVolEnd] = useState(0)
  const [refChapStart, setRefChapStart] = useState(0)
  const [refChapEnd, setRefChapEnd] = useState(0)

  // Load outline from database
  useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const vols = await volumeService.getByNovelId(novelId)
        if (cancelled) return

        const nodes: OutlineNode[] = []
        const expandSet = new Set<string>()

        for (const vol of vols) {
          const chapters = await chapterService.getByVolumeId(vol.id)
          expandSet.add(vol.id)

          const children: OutlineNode[] = chapters.map((ch) => ({
            id: ch.id,
            title: ch.title,
            type: 'chapter' as const,
            order: ch.order,
            summary: ch.summary || '',
            targetWordCount: ch.targetWordCount,
            wordCount: ch.wordCount,
          }))

          nodes.push({
            id: vol.id,
            title: vol.title,
            type: 'volume',
            order: vol.order,
            summary: vol.summary,
            targetWordCount: children.reduce((sum, c) => sum + c.targetWordCount, 0),
            wordCount: children.reduce((sum, c) => sum + c.wordCount, 0),
            children,
          })
        }

        if (!cancelled) {
          setOutline(nodes)
          setExpandedVolumes(expandSet)
        }
      } catch (err) {
        console.error('Failed to load outline:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [novelId, reloadKey, refreshSignal])

  const toggleVolume = (id: string) => {
    setExpandedVolumes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const findNode = (id: string): OutlineNode | undefined => {
    for (const vol of outline) {
      if (vol.id === id) return vol
      const child = vol.children?.find((c) => c.id === id)
      if (child) return child
    }
    return undefined
  }

  const handleCreateVolume = async () => {
    if (!newVolTitle.trim()) return
    const order = outline.length + 1
    const vol: Volume = {
      id: crypto.randomUUID(),
      novelId,
      title: newVolTitle.trim(),
      order,
      summary: '',
    }
    try {
      await volumeService.create(vol)
      setOutline((prev) => [
        ...prev,
        { id: vol.id, title: vol.title, type: 'volume', order, summary: '', targetWordCount: 0, wordCount: 0, children: [] },
      ])
      setNewVolTitle('')
      setShowCreateVol(false)
    } catch (err) {
      console.error('Failed to create volume:', err)
    }
  }

  const handleCreateChapter = async (volumeId: string) => {
    if (!newChTitle.trim()) return
    const vol = outline.find((v) => v.id === volumeId)
    const existingChs = vol?.children || []
    const order = existingChs.length + 1

    const ch: Chapter = {
      id: crypto.randomUUID(),
      volumeId,
      title: newChTitle.trim(),
      order,
      contentPath: `content/${novelId}/${crypto.randomUUID()}.md`,
      wordCount: 0,
      status: 'draft',
      targetWordCount: 3000,
      hooks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    try {
      await chapterService.create(ch)
      const newNode: OutlineNode = {
        id: ch.id, title: ch.title, type: 'chapter', order, summary: '',
        targetWordCount: ch.targetWordCount, wordCount: 0,
      }
      setOutline((prev) =>
        prev.map((v) =>
          v.id === volumeId
            ? { ...v, children: [...(v.children || []), newNode], targetWordCount: v.targetWordCount + ch.targetWordCount }
            : v
        )
      )
      setNewChTitle('')
      setShowCreateCh(null)
    } catch (err) {
      console.error('Failed to create chapter:', err)
    }
  }

  // 获取当前选中项所属卷 ID
  const getSelectedVolumeId = (): string | null => {
    if (!selectedId) return null
    const vol = outline.find((v) => v.id === selectedId || v.children?.some((c) => c.id === selectedId))
    return vol?.id ?? null
  }

  const clearProgressTimer = () => {
    if (progressTimerRef.current !== null) {
      clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }

  // D-T3-1：error 相位统一走 showError（自动 4s 清除）；此前前置校验与 catch 分支只 set 不清除，
  // aiProgress 恒非空导致「构建/完善」按钮永久禁用，重试被阻塞。
  const showError = (message: string) => {
    clearProgressTimer()
    setAiProgress({ phase: 'error', message })
    progressTimerRef.current = window.setTimeout(() => {
      setAiProgress(null)
      progressTimerRef.current = null
    }, 4000)
  }

  const showDoneThenClear = (delay: number) => {
    clearProgressTimer()
    progressTimerRef.current = window.setTimeout(() => {
      setAiProgress(null)
      progressTimerRef.current = null
    }, delay)
  }

  const cancelAI = () => {
    abortRef.current?.abort()
    abortRef.current = null
    clearProgressTimer()
    setAiProgress(null)
  }

  const runBuild = async () => {
    if (aiProgress) return
    // 前置校验先行：在创建 AbortController 之前完成，失败走 showError 可恢复
    const opts: BuildOutlineOptions = { scope: buildScope }
    if (buildScope === 'volume') {
      const vid = getSelectedVolumeId()
      if (!vid) { showError('请先在左侧选择一个章节或卷'); return }
      opts.volumeId = vid
    } else if (buildScope === 'chapter') {
      if (!selectedId) { showError('请先在左侧选择一个章节'); return }
      opts.chapterId = selectedId
    }
    clearProgressTimer()
    const controller = new AbortController()
    abortRef.current = controller
    opts.signal = controller.signal
    setAiProgress({ phase: 'prepare', message: '准备中…' })
    try {
      for await (const p of buildOutline(novelId, opts)) {
        setAiProgress(p)
        if (p.phase === 'error') { showError(p.message ?? '大纲构建失败'); return }
        if (p.phase === 'done') { setReloadKey((k) => k + 1); showDoneThenClear(2000); return }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') showError(`错误: ${e.message}`)
      else { clearProgressTimer(); setAiProgress(null) }
    } finally {
      abortRef.current = null
    }
  }

  const runRefine = async () => {
    if (aiProgress) return
    const opts: RefineOutlineOptions = { scope: refineScope }
    if (refineScope === 'volume') {
      const vid = getSelectedVolumeId()
      if (!vid) { showError('请先在左侧选择一个章节或卷'); return }
      opts.volumeId = vid
      if (refVolStart > 0 && refVolEnd >= refVolStart) opts.refVolumeRange = { start: refVolStart, end: refVolEnd }
    } else if (refineScope === 'chapter') {
      if (!selectedId) { showError('请先在左侧选择一个章节'); return }
      opts.chapterId = selectedId
      if (refChapStart > 0 && refChapEnd >= refChapStart) opts.refChapterRange = { start: refChapStart, end: refChapEnd }
      if (refVolStart > 0 && refVolEnd >= refVolStart) opts.refVolumeRange = { start: refVolStart, end: refVolEnd }
    }
    clearProgressTimer()
    const controller = new AbortController()
    abortRef.current = controller
    opts.signal = controller.signal
    setAiProgress({ phase: 'prepare', message: '准备中…' })
    try {
      for await (const p of refineOutline(novelId, opts)) {
        setAiProgress(p)
        if (p.phase === 'error') { showError(p.message ?? '大纲完善失败'); return }
        if (p.phase === 'done') { setReloadKey((k) => k + 1); showDoneThenClear(2000); return }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') showError(`错误: ${e.message}`)
      else { clearProgressTimer(); setAiProgress(null) }
    } finally {
      abortRef.current = null
    }
  }

  const selected = selectedId ? findNode(selectedId) : undefined
  const totalChapters = outline.reduce((sum, v) => sum + (v.children?.length || 0), 0)
  const totalWords = outline.reduce((sum, v) => sum + v.wordCount, 0)

  return (
    <div className="h-full flex flex-col relative">
      {/* Header */}
      <div className="flex items-center px-3 py-2.5 border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">大纲管理</span>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{totalChapters}章</span>
          <span>{Math.round(totalWords / 10000)}万字</span>
        </div>
      </div>

      {/* AI 大纲工具栏 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border/30 bg-cyan-500/5">
        <Wand2 size={11} className="text-cyan-300" />
        <span className="text-[10px] text-cyan-300 font-medium">构建</span>
        <select value={buildScope} onChange={(e) => setBuildScope(e.target.value as 'full' | 'volume' | 'chapter')} disabled={!!aiProgress} className="px-1.5 py-0.5 rounded bg-muted/40 border border-border/30 text-[10px]">
          <option value="full">全文</option>
          <option value="volume">当前卷</option>
          <option value="chapter">当前章</option>
        </select>
        <button onClick={runBuild} disabled={!!aiProgress} className="px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300 text-[10px] hover:bg-cyan-500/30 disabled:opacity-40">开始</button>
        <span className="mx-1 text-border/30">|</span>
        <Sparkles size={11} className="text-emerald-300" />
        <span className="text-[10px] text-emerald-300 font-medium">完善</span>
        <select value={refineScope} onChange={(e) => setRefineScope(e.target.value as 'full' | 'volume' | 'chapter')} disabled={!!aiProgress} className="px-1.5 py-0.5 rounded bg-muted/40 border border-border/30 text-[10px]">
          <option value="full">全文</option>
          <option value="volume">当前卷</option>
          <option value="chapter">当前章</option>
        </select>
        <button onClick={runRefine} disabled={!!aiProgress} className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] hover:bg-emerald-500/30 disabled:opacity-40">开始</button>
      </div>

      {/* 8.13：写作前大纲（向导）与重订走向 */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border/30 bg-violet-500/5">
        <button onClick={() => onOpenWizard?.(totalChapters)} disabled={!!aiProgress} className="flex-1 flex items-center justify-center gap-1 py-1 rounded-md bg-violet-500/15 border border-violet-500/25 text-[10px] text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 transition-colors">
          <ListTree size={10} /> 新建大纲向导
        </button>
        <button onClick={() => onOpenRecalibrate?.()} disabled={!!aiProgress} className="flex-1 flex items-center justify-center gap-1 py-1 rounded-md bg-cyan-500/10 border border-cyan-500/25 text-[10px] text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 transition-colors">
          <Route size={10} /> 重订走向
        </button>
      </div>

      {/* 完善范围选择器（可选） */}
      {!aiProgress && refineScope !== 'full' && (
        <div className="px-3 py-1.5 border-b border-border/20 text-[10px] text-muted-foreground/70 space-y-1">
          {refineScope === 'volume' && (
            <div className="flex items-center gap-1">
              <span>参考卷范围（可选）:</span>
              <input type="number" min={0} value={refVolStart} onChange={(e) => setRefVolStart(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
              <span>-</span>
              <input type="number" min={0} value={refVolEnd} onChange={(e) => setRefVolEnd(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
            </div>
          )}
          {refineScope === 'chapter' && (
            <div className="space-y-1">
              <div className="flex items-center gap-1">
                <span>参考章范围（可选）:</span>
                <input type="number" min={0} value={refChapStart} onChange={(e) => setRefChapStart(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
                <span>-</span>
                <input type="number" min={0} value={refChapEnd} onChange={(e) => setRefChapEnd(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
              </div>
              <div className="flex items-center gap-1">
                <span>参考卷范围（可选）:</span>
                <input type="number" min={0} value={refVolStart} onChange={(e) => setRefVolStart(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
                <span>-</span>
                <input type="number" min={0} value={refVolEnd} onChange={(e) => setRefVolEnd(+e.target.value)} className="w-10 px-1 py-0.5 rounded bg-muted/30 border border-border/20" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* AI 进度 */}
      {aiProgress && (
        <div className={cn(
          'px-3 py-2 border-b text-[10px] space-y-1',
          aiProgress.phase === 'error' ? 'bg-red-500/5 border-red-500/20 text-red-400'
            : aiProgress.phase === 'done' ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
              : 'bg-cyan-500/5 border-cyan-500/20 text-cyan-300',
        )}>
          <div className="flex items-center gap-1.5">
            {aiProgress.phase !== 'done' && aiProgress.phase !== 'error' && <Loader2 size={10} className="animate-spin" />}
            <span>{aiProgress.message}</span>
            {aiProgress.phase !== 'done' && aiProgress.phase !== 'error' && (
              <button onClick={cancelAI} className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">
                <Square size={8} /> 停止
              </button>
            )}
            {/* D-T3-1：错误横幅可手动关闭，立即恢复重试入口 */}
            {aiProgress.phase === 'error' && (
              <button onClick={() => { clearProgressTimer(); setAiProgress(null) }} className="ml-auto px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 hover:bg-red-500/25">
                关闭
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Outline tree */}
        <div className="w-64 flex-shrink-0 border-r border-border/20 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
            </div>
          ) : outline.length === 0 ? (
            <div className="py-8 text-center">
              <FileText size={20} className="mx-auto text-muted-foreground/20 mb-2" />
              <p className="text-xs text-muted-foreground/60">暂无大纲结构</p>
              <button
                onClick={() => setShowCreateVol(true)}
                className="text-[10px] text-primary hover:underline mt-1"
              >
                创建第一卷
              </button>
            </div>
          ) : (
            outline.map((vol) => (
              <div key={vol.id}>
                <button
                  onClick={() => toggleVolume(vol.id)}
                  className={cn(
                    'w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded',
                    'hover:bg-muted/20 transition-colors text-left'
                  )}
                >
                  <ChevronRight
                    size={12}
                    className={cn(
                      'text-muted-foreground transition-transform flex-shrink-0',
                      expandedVolumes.has(vol.id) && 'rotate-90'
                    )}
                  />
                  <BookOpen size={12} className="text-primary flex-shrink-0" />
                  <span className="truncate">{vol.title}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">
                    {vol.children?.length || 0}章
                  </span>
                </button>

                {expandedVolumes.has(vol.id) && (
                  <div className="ml-3 border-l border-border/20">
                    {vol.children?.map((ch) => (
                      <button
                        key={ch.id}
                        onClick={() => setSelectedId(ch.id)}
                        className={cn(
                          'w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded text-left',
                          'hover:bg-muted/20 transition-colors',
                          selectedId === ch.id
                            ? 'bg-primary/10 text-foreground border-l-[3px] border-primary -ml-[1px]'
                            : 'text-muted-foreground border-l-[3px] border-transparent -ml-[1px]'
                        )}
                      >
                        <span className="text-[10px] text-muted-foreground w-5 flex-shrink-0">{ch.order}.</span>
                        <span className="truncate">{ch.title}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground/60 flex-shrink-0">
                          {ch.wordCount > 0 ? `${Math.round(ch.wordCount / 1000)}k` : ''}
                        </span>
                      </button>
                    ))}
                    {showCreateCh === vol.id ? (
                      <div className="flex items-center gap-1 px-2 py-1">
                        <input
                          value={newChTitle}
                          onChange={(e) => setNewChTitle(e.target.value)}
                          placeholder="章节名称..."
                          className="flex-1 px-1.5 py-0.5 rounded text-xs bg-muted/20 border border-border/40"
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleCreateChapter(vol.id)}
                        />
                        <Button size="icon-sm" variant="ghost" onClick={() => handleCreateChapter(vol.id)}>
                          <Plus size={10} />
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setShowCreateCh(vol.id); setNewChTitle('') }}
                        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        <Plus size={10} />
                        添加章节
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          {showCreateVol ? (
            <div className="flex items-center gap-1 px-2 py-1 mt-1">
              <input
                value={newVolTitle}
                onChange={(e) => setNewVolTitle(e.target.value)}
                placeholder="卷名称..."
                className="flex-1 px-1.5 py-0.5 rounded text-xs bg-muted/20 border border-border/40"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreateVolume()}
              />
              <Button size="icon-sm" variant="ghost" onClick={handleCreateVolume}>
                <Plus size={10} />
              </Button>
            </div>
          ) : (
            <button
              onClick={() => { setShowCreateVol(true); setNewVolTitle('') }}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 mt-1 text-xs text-muted-foreground/60 hover:text-muted-foreground rounded hover:bg-muted/20 transition-colors"
            >
              <Plus size={12} />
              新建卷
            </button>
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 p-4 overflow-y-auto">
          {selected ? (
            <div className="space-y-4">
              <div>
                <Badge variant="secondary" className="text-[10px]">
                  {selected.type === 'volume' ? '卷' : '章节'}
                </Badge>
                <h3 className="text-lg font-semibold text-foreground mt-2">{selected.title}</h3>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">内容概要</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {selected.summary || '暂无概要'}
                </p>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">字数信息</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-muted/20 rounded p-2">
                    <span className="text-muted-foreground">当前字数</span>
                    <p className="text-foreground font-medium">{selected.wordCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-muted/20 rounded p-2">
                    <span className="text-muted-foreground">目标字数</span>
                    <p className="text-foreground font-medium">{selected.targetWordCount.toLocaleString()}</p>
                  </div>
                </div>
              </div>

              {selected.type === 'volume' && selected.children && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">
                    包含章节 ({selected.children.length})
                  </h4>
                  <div className="space-y-1">
                    {selected.children.map((ch) => (
                      <div key={ch.id} className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1">
                        {ch.order}. {ch.title}
                        <span className="ml-2 text-[10px] opacity-60">{ch.targetWordCount.toLocaleString()}字</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              选择一个章节查看大纲
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
