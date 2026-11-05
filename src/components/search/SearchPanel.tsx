import { useState, useCallback } from 'react'
import { Search, X, FileText, CornerDownRight } from 'lucide-react'
import { searchChapters, type SearchHit } from '@/services/data-service'
import { cn } from '@/utils/cn'

interface SearchPanelProps {
  novelId: string
  onClose: () => void
  onJump: (chapterId: string) => void
  isOpen: boolean
}

export default function SearchPanel({ novelId, onClose, onJump, isOpen }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const runSearch = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setSearched(true)
    try {
      const result = await searchChapters(novelId, query)
      setHits(result.hits)
      setTotal(result.total)
    } catch (e) {
      console.error('Search failed:', e)
      setHits([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [novelId, query])

  if (!isOpen) return null

  return (
    <div className="absolute inset-0 z-40 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[420px] h-full bg-card border-l border-border/40 shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/30">
          <Search size={14} className="text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
            placeholder="搜索正文关键词…"
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground/40"
          />
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && (
            <div className="text-center text-xs text-muted-foreground py-8">搜索中…</div>
          )}
          {!loading && searched && hits.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-8">
              未找到 “{query}” 相关结果
            </div>
          )}
          {!loading && !searched && (
            <div className="text-center text-xs text-muted-foreground/50 py-8">
              输入关键词，跨全书章节正文检索
            </div>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.chapterId}-${hit.line}-${i}`}
              onClick={() => onJump(hit.chapterId)}
              className={cn(
                'group w-full text-left px-2.5 py-2 rounded-lg mb-1',
                'hover:bg-muted/30 transition-colors border border-transparent hover:border-border/30'
              )}
            >
              <div className="flex items-center gap-1.5 text-[12px] text-foreground font-medium">
                <FileText size={11} className="text-primary flex-shrink-0" />
                <span className="truncate">{hit.chapterTitle}</span>
                <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                  {hit.volumeTitle} · L{hit.line}
                </span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                {hit.snippet}
              </div>
              <div className="flex items-center gap-1 mt-1 text-[10px] text-primary opacity-0 group-hover:opacity-100">
                <CornerDownRight size={10} /> 跳转
              </div>
            </button>
          ))}
          {!loading && hits.length > 0 && total > hits.length && (
            <div className="px-2.5 py-2 text-[10px] text-muted-foreground/70 text-center border-t border-border/20 mt-1">
              共 {total} 条命中，仅显示前 {hits.length} 条，可换更精确的关键词
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
