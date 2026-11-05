import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  GripVertical,
  Layers,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { VolChap } from '@/services/ai-outline'
import { cn } from '@/utils/cn'
import {
  chapterDot,
  type ChapterDot,
  type PlanSelection,
} from './plan-utils'

interface Props {
  vols: VolChap[]
  selection: PlanSelection
  masterOutlineEmpty: boolean
  onSelect: (selection: PlanSelection) => void
  onAddVolume: () => void
  onAddChapter: (volumeId: string) => void
  onDeleteVolume: (volumeId: string) => void
  onDeleteChapter: (chapterId: string) => void
  onMoveVolume: (volumeId: string, targetIndex: number) => void
  onMoveChapter: (chapterId: string, targetVolumeId: string, targetIndex: number) => void
  onAiForVolume: (volumeId: string) => void
  onAiForChapter: (volumeId: string, chapterId: string) => void
}

type DragPayload =
  | { kind: 'volume'; id: string }
  | { kind: 'chapter'; id: string; volumeId: string }

const DOT_CLASS: Record<ChapterDot, string> = {
  written: 'bg-emerald-400',
  planned: 'bg-sky-400',
  empty: 'bg-zinc-600',
}

function readPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData('application/x-plan-node')
    return raw ? (JSON.parse(raw) as DragPayload) : null
  } catch {
    return null
  }
}

function writePayload(e: React.DragEvent, payload: DragPayload) {
  e.dataTransfer.setData('application/x-plan-node', JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'move'
}

export default function PlanTree({
  vols,
  selection,
  masterOutlineEmpty,
  onSelect,
  onAddVolume,
  onAddChapter,
  onDeleteVolume,
  onDeleteChapter,
  onMoveVolume,
  onMoveChapter,
  onAiForVolume,
  onAiForChapter,
}: Props) {
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return vols.map((v, sourceIndex) => ({ ...v, sourceIndex }))
    return vols
      .map((v, sourceIndex) => {
        const volumeHit =
          v.vol.title.toLowerCase().includes(keyword) ||
          v.vol.summary.toLowerCase().includes(keyword)
        const chapters = volumeHit
          ? v.chapters
          : v.chapters.filter(
              (c) =>
                c.title.toLowerCase().includes(keyword) ||
                (c.summary ?? '').toLowerCase().includes(keyword) ||
                c.hooks?.some((h) => h.toLowerCase().includes(keyword)),
            )
        return { ...v, chapters, sourceIndex }
      })
      .filter((v) => v.chapters.length > 0 || v.vol.title.toLowerCase().includes(keyword))
  }, [vols, search])

  const toggle = (volumeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(volumeId)) next.delete(volumeId)
      else next.add(volumeId)
      return next
    })
  }

  const handleDropOnVolume = (e: React.DragEvent, volumeId: string, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const payload = readPayload(e)
    if (!payload) return
    if (payload.kind === 'volume') {
      if (payload.id !== volumeId) onMoveVolume(payload.id, index)
    } else {
      const target = vols.find((v) => v.vol.id === volumeId)
      onMoveChapter(payload.id, volumeId, target?.chapters.length ?? 0)
    }
  }

  const handleDropOnChapter = (
    e: React.DragEvent,
    volumeId: string,
    volumeIndex: number,
    chapterIndex: number,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const payload = readPayload(e)
    if (!payload) return
    if (payload.kind === 'volume') onMoveVolume(payload.id, volumeIndex)
    else onMoveChapter(payload.id, volumeId, chapterIndex)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/40">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索卷 / 章 / 细纲"
            className="h-7 w-full rounded-md bg-muted/30 border border-border/50 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <button
          onClick={onAddVolume}
          title="新建卷"
          className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
        <button
          onClick={() => onSelect({ kind: 'master' })}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
            selection.kind === 'master'
              ? 'bg-primary/15 text-primary'
              : 'text-foreground/85 hover:bg-muted/40',
          )}
        >
          <Sparkles size={12} className="flex-shrink-0" />
          <span className="flex-1 truncate">全书主线</span>
          {masterOutlineEmpty && <AlertTriangle size={11} className="text-amber-400/80" />}
        </button>

        {filtered.map(({ vol, chapters, sourceIndex }) => {
          const isCollapsed = collapsed.has(vol.id)
          const selectedVolume = selection.kind === 'volume' && selection.volumeId === vol.id
          const realChapters = vols[sourceIndex]?.chapters ?? chapters
          const volumeMissingHooks = chapters.filter(
            (c) => c.wordCount === 0 && (c.hooks?.length ?? 0) === 0,
          ).length
          const writtenCount = chapters.filter((c) => c.wordCount > 0).length
          return (
            <div key={vol.id} className="rounded-md">
              <div
                draggable
                onDragStart={(e) => writePayload(e, { kind: 'volume', id: vol.id })}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDropOnVolume(e, vol.id, sourceIndex)}
                onClick={() => onSelect({ kind: 'volume', volumeId: vol.id })}
                className={cn(
                  'group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs transition-colors',
                  selectedVolume ? 'bg-primary/15 text-primary' : 'text-foreground/85 hover:bg-muted/40',
                )}
              >
                <GripVertical
                  size={10}
                  className="flex-shrink-0 text-transparent group-hover:text-muted-foreground/50 cursor-grab"
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(vol.id)
                  }}
                  className="flex-shrink-0 text-muted-foreground/70 hover:text-foreground"
                >
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                </button>
                <Layers size={12} className="flex-shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">
                  第{vol.order}卷 · {vol.title || '未命名'}
                </span>
                {volumeMissingHooks > 0 && (
                  <span
                    title={`${volumeMissingHooks} 章缺细纲`}
                    className="flex items-center gap-0.5 text-[10px] text-amber-400/90 flex-shrink-0"
                  >
                    <AlertTriangle size={9} />
                    {volumeMissingHooks}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/70 flex-shrink-0">
                  {writtenCount > 0 ? `${writtenCount}/${chapters.length}` : `${chapters.length} 章`}
                </span>
                <span className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                  <button
                    title="生成本卷章纲"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAiForVolume(vol.id)
                    }}
                    className="p-0.5 rounded text-muted-foreground hover:text-violet-300 hover:bg-violet-500/15"
                  >
                    <Sparkles size={10} />
                  </button>
                  <button
                    title="添加章节"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddChapter(vol.id)
                    }}
                    className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60"
                  >
                    <Plus size={10} />
                  </button>
                  <button
                    title="删除卷"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteVolume(vol.id)
                    }}
                    className="p-0.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 size={10} />
                  </button>
                </span>
              </div>

              {!isCollapsed && (
                <div
                  className="ml-4 border-l border-border/40 pl-1.5"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDropOnVolume(e, vol.id, sourceIndex)}
                >
                  {chapters.length === 0 && (
                    <button
                      onClick={() => onAddChapter(vol.id)}
                      className="my-1 flex w-full items-center gap-1.5 rounded px-2 py-1 text-[11px] text-muted-foreground/70 hover:bg-muted/30 hover:text-foreground"
                    >
                      <Plus size={10} /> 添加第一章
                    </button>
                  )}
                  {chapters.map((ch) => {
                    const selectedChapter =
                      selection.kind === 'chapter' && selection.chapterId === ch.id
                    const dot = chapterDot(ch)
                    // 搜索过滤时列表为子集，落点必须换算回原始章序
                    const realChapterIndex = Math.max(
                      0,
                      realChapters.findIndex((c) => c.id === ch.id),
                    )
                    return (
                      <div
                        key={ch.id}
                        draggable
                        onDragStart={(e) =>
                          writePayload(e, { kind: 'chapter', id: ch.id, volumeId: vol.id })
                        }
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) =>
                          handleDropOnChapter(e, vol.id, sourceIndex, realChapterIndex)
                        }
                        onClick={() =>
                          onSelect({ kind: 'chapter', volumeId: vol.id, chapterId: ch.id })
                        }
                        className={cn(
                          'group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors',
                          selectedChapter
                            ? 'bg-primary/15 text-primary'
                            : 'text-foreground/75 hover:bg-muted/35',
                        )}
                      >
                        <GripVertical
                          size={9}
                          className="flex-shrink-0 text-transparent group-hover:text-muted-foreground/40 cursor-grab"
                        />
                        <span className={cn('h-1.5 w-1.5 rounded-full flex-shrink-0', DOT_CLASS[dot])} />
                        <FileText size={10} className="flex-shrink-0 text-muted-foreground/70" />
                        <span className="flex-1 truncate">
                          {ch.order}. {ch.title || '未命名'}
                        </span>
                        {(ch.hooks?.length ?? 0) > 0 && (
                          <span className="text-[9px] text-sky-400/80 flex-shrink-0">
                            {ch.hooks.length} 钩
                          </span>
                        )}
                        <span className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                          <button
                            title="AI 细化本章"
                            onClick={(e) => {
                              e.stopPropagation()
                              onAiForChapter(vol.id, ch.id)
                            }}
                            className="p-0.5 rounded text-muted-foreground hover:text-violet-300 hover:bg-violet-500/15"
                          >
                            <Sparkles size={9} />
                          </button>
                          <button
                            title="删除章"
                            onClick={(e) => {
                              e.stopPropagation()
                              onDeleteChapter(ch.id)
                            }}
                            className="p-0.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                          >
                            <Trash2 size={9} />
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        {vols.length === 0 && (
          <div className="px-2 py-4 text-center text-[11px] leading-relaxed text-muted-foreground/70">
            还没有分卷。
            <br />
            右侧用「主线分卷」生成，或点上方 + 手动建卷。
          </div>
        )}
      </div>

      <div className="border-t border-border/40 px-3 py-2 text-[10px] text-muted-foreground/70">
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />已写</span>
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-sky-400" />有细纲</span>
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />空章</span>
        </span>
      </div>
    </div>
  )
}
