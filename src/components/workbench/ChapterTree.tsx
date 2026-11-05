import { useState, useEffect, useRef, KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, FileText, Plus, Loader2, Trash2 } from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import { volumeService, chapterService } from '@/services/data-service'
import { cn } from '@/utils/cn'
import type { Volume, Chapter } from '@shared/types'

type EditTarget = { kind: 'volume' | 'chapter'; id: string } | null

export default function ChapterTree({ novelId }: { novelId: string }) {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [chaptersMap, setChaptersMap] = useState<Record<string, Chapter[]>>({})
  const [expandedVolumes, setExpandedVolumes] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState<string | null>(null) // volumeId for chapter create, 'vol' for volume
  const [createName, setCreateName] = useState('')
  const [editing, setEditing] = useState<EditTarget>(null)
  const [editName, setEditName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)

  useEffect(() => {
    let cancelled = false
    async function loadData() {
      setLoading(true)
      try {
        const vols = await volumeService.getByNovelId(novelId)
        if (cancelled) return
        setVolumes(vols)
        setExpandedVolumes(new Set(vols.map((v) => v.id)))
        const map: Record<string, Chapter[]> = {}
        for (const vol of vols) {
          const chapters = await chapterService.getByVolumeId(vol.id)
          map[vol.id] = chapters
        }
        if (!cancelled) setChaptersMap(map)
      } catch (err) {
        console.error('Failed to load chapters:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [novelId])

  useEffect(() => {
    // 进入创建/编辑态后自动聚焦
    if ((creating || editing) && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [creating, editing])

  // 同步外部对选中章节的修改（例如在编辑器中改了标题），避免切换回来后回退为旧名
  useEffect(() => {
    if (!selectedChapter) return
    setChaptersMap((prev) => {
      const next = { ...prev }
      let changed = false
      for (const vid of Object.keys(next)) {
        if (next[vid].some((c) => c.id === selectedChapter.id)) {
          next[vid] = next[vid].map((c) => (c.id === selectedChapter.id ? { ...c, ...selectedChapter } : c))
          changed = true
          break
        }
      }
      return changed ? next : prev
    })
  }, [selectedChapter])

  const toggleVolume = (volId: string) => {
    setExpandedVolumes((prev) => {
      const next = new Set(prev)
      if (next.has(volId)) next.delete(volId)
      else next.add(volId)
      return next
    })
  }

  const handleSelectChapter = (ch: Chapter) => {
    selectChapter(ch)
  }

  const startCreateVolume = () => {
    setEditing(null)
    setCreating('vol')
    setCreateName(`第${volumes.length + 1}卷`)
  }

  const startCreateChapter = (volumeId: string) => {
    setEditing(null)
    const order = (chaptersMap[volumeId] || []).length + 1
    setCreating(volumeId)
    setCreateName(`第${order}章`)
  }

  const commitCreate = async () => {
    const name = createName.trim()
    if (!name) { setCreating(null); return }
    if (creating === 'vol') {
      const volume: Volume = {
        id: crypto.randomUUID(),
        novelId,
        title: name,
        order: volumes.length + 1,
        summary: '',
      }
      try {
        await volumeService.create(volume)
        setVolumes((prev) => [...prev, volume])
        setChaptersMap((prev) => ({ ...prev, [volume.id]: [] }))
        setExpandedVolumes((prev) => new Set([...prev, volume.id]))
      } catch (err) {
        console.error('Failed to create volume:', err)
      }
    } else if (creating) {
      const volumeId = creating
      const order = (chaptersMap[volumeId] || []).length + 1
      const chapter: Chapter = {
        id: crypto.randomUUID(),
        volumeId,
        title: name,
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
        await chapterService.create(chapter)
        setChaptersMap((prev) => ({
          ...prev,
          [volumeId]: [...(prev[volumeId] || []), chapter],
        }))
        selectChapter(chapter)
      } catch (err) {
        console.error('Failed to create chapter:', err)
      }
    }
    setCreating(null)
    setCreateName('')
  }

  const startRename = (kind: 'volume' | 'chapter', item: Volume | Chapter) => {
    setCreating(null)
    setEditing({ kind, id: item.id })
    setEditName(item.title)
  }

  const commitRename = async () => {
    const name = editName.trim()
    if (!name || !editing) { setEditing(null); return }
    try {
      if (editing.kind === 'volume') {
        await volumeService.update(editing.id, { title: name })
        setVolumes((prev) => prev.map((v) => (v.id === editing.id ? { ...v, title: name } : v)))
      } else {
        const chapter = Object.values(chaptersMap).flat().find((c) => c.id === editing.id)
        await chapterService.update(editing.id, { title: name })
        if (chapter) {
          const updated = { ...chapter, title: name }
          setChaptersMap((prev) => {
            const next = { ...prev }
            for (const vid of Object.keys(next)) {
              next[vid] = next[vid].map((c) => (c.id === editing.id ? updated : c))
            }
            return next
          })
          // 若正编辑该章节，同步工作台选中态
          if (selectedChapter?.id === editing.id) selectChapter(updated)
        }
      }
    } catch (err) {
      console.error('Failed to rename:', err)
    }
    setEditing(null)
    setEditName('')
  }

  const cancelInline = () => {
    setCreating(null)
    setEditing(null)
    setCreateName('')
    setEditName('')
  }

  const confirmDeleteVolume = async (volId: string, volTitle: string) => {
    const count = (chaptersMap[volId] || []).length
    const msg = count > 0
      ? `确定删除「${volTitle}」吗？该卷下的 ${count} 章及正文将被一并删除，此操作不可撤销。`
      : `确定删除「${volTitle}」吗？此操作不可撤销。`
    if (!window.confirm(msg)) return
    try {
      await volumeService.delete(volId)
      setVolumes((prev) => prev.filter((v) => v.id !== volId))
      setChaptersMap((prev) => {
        const next = { ...prev }
        delete next[volId]
        return next
      })
      setExpandedVolumes((prev) => {
        const next = new Set(prev)
        next.delete(volId)
        return next
      })
      // 若当前选中的章节属于被删卷，清空选中态
      if (selectedChapter && selectedChapter.volumeId === volId) selectChapter(null)
    } catch (err) {
      console.error('Failed to delete volume:', err)
      window.alert('删除卷失败，请重试。')
    }
  }

  const confirmDeleteChapter = async (ch: Chapter) => {
    const volId = ch.volumeId
    if (!window.confirm(`确定删除「${ch.title}」吗？正文将被一并删除，此操作不可撤销。`)) return
    try {
      await chapterService.delete(ch.id)
      setChaptersMap((prev) => ({
        ...prev,
        [volId]: (prev[volId] || []).filter((c) => c.id !== ch.id),
      }))
      if (selectedChapter?.id === ch.id) selectChapter(null)
    } catch (err) {
      console.error('Failed to delete chapter:', err)
      window.alert('删除章节失败，请重试。')
    }
  }

  const onInlineKey = (e: KeyboardEvent<HTMLInputElement>, commit: () => void) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') cancelInline()
  }

  const statusIndicator = (status: string) => {
    const colors: Record<string, string> = {
      draft: 'bg-muted-foreground/40',
      reviewed: 'bg-blue-400',
      polished: 'bg-purple-400',
      final: 'bg-green-400',
    }
    return colors[status] || 'bg-muted-foreground/40'
  }

  return (
    <div className="h-full flex flex-col select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/30">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">章节目录</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={startCreateVolume}
            className="p-1 rounded hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors"
            title="新建卷"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Volumes & Chapters */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-muted-foreground/50" />
          </div>
        )}

        {!loading && volumes.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FileText size={24} className="text-muted-foreground/20 mb-2" />
            <p className="text-xs text-muted-foreground/60">尚无章节目录</p>
            <button
              onClick={startCreateVolume}
              className="text-xs text-primary hover:underline mt-1"
            >
              创建第一卷
            </button>
          </div>
        )}

        {volumes.map((vol) => {
          const chapters = chaptersMap[vol.id] || []
          const isEditingVol = editing?.kind === 'volume' && editing.id === vol.id
          return (
            <div key={vol.id} className="group-vol">
              {/* Volume Header */}
              <div
                className={cn(
                  'w-full flex items-center gap-1.5 px-2 py-1.5',
                  'text-sm font-medium text-foreground/80',
                  'hover:bg-muted/30 transition-colors'
                )}
              >
                <button
                  onClick={() => toggleVolume(vol.id)}
                  className="flex-shrink-0"
                >
                  {expandedVolumes.has(vol.id) ? (
                    <ChevronDown size={14} className="text-muted-foreground" />
                  ) : (
                    <ChevronRight size={14} className="text-muted-foreground" />
                  )}
                </button>
                {isEditingVol ? (
                  <input
                    ref={inputRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => onInlineKey(e, commitRename)}
                    className="flex-1 min-w-0 bg-muted/40 border border-primary/40 rounded px-1.5 py-0.5 text-sm text-foreground focus:outline-none"
                  />
                ) : (
                  <span
                    className="truncate flex-1 text-left cursor-text"
                    onDoubleClick={() => startRename('volume', vol)}
                    title="双击重命名"
                  >
                    {vol.title}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground mr-1">
                  {chapters.length}章
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    confirmDeleteVolume(vol.id, vol.title)
                  }}
                  className="p-0.5 rounded opacity-50 hover:opacity-100 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-all"
                  title="删除卷"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {/* Chapters */}
              {expandedVolumes.has(vol.id) && (
                <div className="ml-2 border-l border-border/20">
                  {chapters.map((ch) => {
                    const isSelected = selectedChapter?.id === ch.id
                    const isEditingCh = editing?.kind === 'chapter' && editing.id === ch.id
                    return (
                      <div
                        key={ch.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectChapter(ch)}
                        onDoubleClick={() => startRename('chapter', ch)}
                        onKeyDown={(e) => {
                          if (isEditingCh) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            handleSelectChapter(ch)
                          }
                        }}
                        className={cn(
                          'group-ch w-full flex items-center gap-2 px-2 py-1.5 pl-3',
                          'text-xs transition-all duration-100 outline-none',
                          'hover:bg-muted/30 focus-visible:bg-muted/30',
                          isSelected
                            ? 'bg-primary/10 text-foreground border-l-[3px] border-primary -ml-[1px]'
                            : 'text-muted-foreground border-l-[3px] border-transparent -ml-[1px]'
                        )}
                      >
                        <div className={cn(
                          'w-1.5 h-1.5 rounded-full flex-shrink-0',
                          statusIndicator(ch.status)
                        )} />
                        <FileText size={12} className="flex-shrink-0 opacity-50" />
                        {isEditingCh ? (
                          <input
                            ref={inputRef}
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => onInlineKey(e, commitRename)}
                            onClick={(e) => e.stopPropagation()}
                            className="truncate flex-1 min-w-0 bg-muted/40 border border-primary/40 rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none text-left"
                          />
                        ) : (
                          <span className="truncate flex-1 text-left">{ch.title}</span>
                        )}
                        {ch.wordCount > 0 && (
                          <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                            {(ch.wordCount / 1000).toFixed(1)}k
                          </span>
                        )}
                        {!isEditingCh && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              confirmDeleteChapter(ch)
                            }}
                            className="p-0.5 rounded opacity-50 hover:opacity-100 hover:bg-red-500/15 text-muted-foreground hover:text-red-400 transition-all flex-shrink-0"
                            title="删除章节"
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    )
                  })}

                  {/* Add chapter button / inline create */}
                  {creating === vol.id ? (
                    <div className="flex items-center gap-1 px-2 py-1 pl-6">
                      <input
                        ref={inputRef}
                        value={createName}
                        onChange={(e) => setCreateName(e.target.value)}
                        onBlur={commitCreate}
                        onKeyDown={(e) => onInlineKey(e, commitCreate)}
                        placeholder="章节名"
                        className="flex-1 min-w-0 bg-muted/40 border border-primary/40 rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => startCreateChapter(vol.id)}
                      disabled={creating === vol.id}
                      className={cn(
                        'w-full flex items-center gap-1.5 px-2 py-1 pl-6',
                        'text-xs text-muted-foreground/60',
                        'hover:text-muted-foreground hover:bg-muted/20',
                        'transition-colors'
                      )}
                    >
                      {creating === vol.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Plus size={10} />
                      )}
                      新建章节
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* Inline create volume */}
        {creating === 'vol' && (
          <div className="flex items-center gap-1 px-2 py-1.5 pl-3">
            <input
              ref={inputRef}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => onInlineKey(e, commitCreate)}
              placeholder="卷名"
              className="flex-1 min-w-0 bg-muted/40 border border-primary/40 rounded px-1.5 py-0.5 text-sm text-foreground focus:outline-none"
            />
          </div>
        )}
      </div>
    </div>
  )
}
