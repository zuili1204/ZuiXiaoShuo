import { useState, useEffect, useCallback } from 'react'
import { worldviewService } from '@/services/data-service'
import { reindexWorldview, removeWorldviewIndex } from '@/services/rag-service'
import type { Worldview, WorldviewCategory } from '@shared/types'
import { Plus, Trash2, Save, X } from 'lucide-react'

const CATEGORIES: { value: WorldviewCategory; label: string }[] = [
  { value: 'power', label: '力量体系' },
  { value: 'cultivation', label: '修炼' },
  { value: 'geography', label: '地理' },
  { value: 'history', label: '历史' },
  { value: 'society', label: '社会' },
  { value: 'magic', label: '魔法' },
  { value: 'tech', label: '科技' },
  { value: 'other', label: '其他' },
]

export default function WorldviewPanel({ novelId }: { novelId: string }) {
  const effectiveNovelId = novelId || ''
  const [items, setItems] = useState<Worldview[]>([])
  const [editing, setEditing] = useState<Partial<Worldview> | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!effectiveNovelId) return
    setLoading(true)
    try {
      setItems(await worldviewService.getByNovelId(effectiveNovelId))
    } catch (e) {
      console.error('[worldview] load failed', e)
    } finally {
      setLoading(false)
    }
  }, [effectiveNovelId])

  useEffect(() => {
    load()
  }, [load])

  const startNew = () =>
    setEditing({ novelId: effectiveNovelId, category: 'other', title: '', content: '' })

  const save = async () => {
    if (!editing) return
    const payload = {
      category: (editing.category ?? 'other') as WorldviewCategory,
      title: editing.title?.trim() || '未命名设定',
      content: editing.content ?? '',
    }
    if (editing.id) {
      const updated = await worldviewService.update(editing.id, payload)
      // P2-10：编辑后增量 upsert RAG 分块（替代全量 indexNovelAssets）
      try { reindexWorldview(effectiveNovelId, updated) } catch (e) { console.error('[worldview] reindex failed', e) }
    } else {
      const created = await worldviewService.create({ ...payload, novelId: effectiveNovelId })
      try { reindexWorldview(effectiveNovelId, created) } catch (e) { console.error('[worldview] reindex failed', e) }
    }
    setEditing(null)
    load()
  }

  const remove = async (id: string) => {
    await worldviewService.delete(id)
    // P2-10：删除后增量移除 RAG 分块
    try { removeWorldviewIndex(effectiveNovelId, id) } catch (e) { console.error('[worldview] remove index failed', e) }
    load()
  }

  return (
    <div className="flex h-full">
      {/* 左：设定列表 */}
      <div className="w-56 border-r border-border/30 p-2 overflow-y-auto space-y-1">
        <button
          onClick={startNew}
          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-primary/15 text-primary text-xs hover:bg-primary/25 transition-colors"
        >
          <Plus size={12} /> 新增设定
        </button>
        {loading && <div className="text-xs text-foreground/40 px-1 py-2">加载中…</div>}
        {!loading && items.length === 0 && (
          <div className="text-xs text-foreground/40 px-1 py-2">暂无世界观设定</div>
        )}
        {items.map((w) => (
          <div
            key={w.id}
            className="group flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer"
            onClick={() => setEditing({ ...w })}
          >
            <div className="min-w-0">
              <div className="text-xs text-foreground truncate">{w.title}</div>
              <div className="text-[9px] text-foreground/40">
                {CATEGORIES.find((c) => c.value === w.category)?.label ?? w.category}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                remove(w.id)
              }}
              className="opacity-0 group-hover:opacity-100 text-red-400/70 hover:text-red-400"
              title="删除"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* 右：编辑器 */}
      <div className="flex-1 p-3 overflow-y-auto">
        {!editing && (
          <div className="text-sm text-foreground/40 mt-10 text-center">
            从左侧选择或新增一条世界观设定。<br />
            设定会在写作时自动注入 AI 上下文（修复"AI 不读世界观"问题）。
          </div>
        )}
        {editing && (
          <div className="space-y-3 max-w-2xl">
            <div className="flex items-center gap-2">
              <select
                value={editing.category ?? 'other'}
                onChange={(e) =>
                  setEditing({ ...editing, category: e.target.value as WorldviewCategory })
                }
                className="px-2 py-1.5 rounded bg-muted/50 border border-border/30 text-xs"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                value={editing.title ?? ''}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="设定名称，如「灵气修炼体系」"
                className="flex-1 px-2 py-1.5 rounded bg-muted/50 border border-border/30 text-sm"
              />
              <button
                onClick={save}
                className="flex items-center gap-1 px-2 py-1.5 rounded bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30"
              >
                <Save size={12} /> 保存
              </button>
              <button
                onClick={() => setEditing(null)}
                className="flex items-center gap-1 px-2 py-1.5 rounded bg-muted/40 text-foreground/60 text-xs hover:bg-muted/60"
              >
                <X size={12} /> 取消
              </button>
            </div>
            <textarea
              value={editing.content ?? ''}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              placeholder="描述该设定的规则、源流、约束与在剧情中的作用…"
              className="w-full h-[60vh] px-3 py-2 rounded bg-muted/30 border border-border/30 text-sm leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            {editing.id && (
              <div className="flex justify-end">
                <button
                  onClick={() => remove(editing.id!)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-red-400/70 text-xs hover:bg-red-500/10"
                >
                  <Trash2 size={12} /> 删除此设定
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
