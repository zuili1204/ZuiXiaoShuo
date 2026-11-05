import { useState, useEffect, useCallback } from 'react'
import { forceService } from '@/services/data-service'
import { indexNovelAssets } from '@/services/rag-service'
import type { Force, ForceType } from '@shared/types'
import { Plus, Trash2, Save, X } from 'lucide-react'

const FORCE_TYPES: { value: ForceType; label: string }[] = [
  { value: 'sect', label: '门派/宗门' },
  { value: 'empire', label: '帝国/王朝' },
  { value: 'organization', label: '组织/帮会' },
  { value: 'family', label: '家族' },
  { value: 'guild', label: '公会/商会' },
  { value: 'army', label: '军队/势力' },
  { value: 'other', label: '其他' },
]

const typeLabel = (t: ForceType) => FORCE_TYPES.find((c) => c.value === t)?.label ?? t

export default function ForcePanel({ novelId }: { novelId: string }) {
  const effectiveNovelId = novelId || ''
  const [items, setItems] = useState<Force[]>([])
  const [editing, setEditing] = useState<Partial<Force> | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!effectiveNovelId) return
    setLoading(true)
    try {
      setItems(await forceService.getByNovelId(effectiveNovelId))
    } catch (e) {
      console.error('[force] load failed', e)
    } finally {
      setLoading(false)
    }
  }, [effectiveNovelId])

  useEffect(() => {
    load()
  }, [load])

  const reindex = useCallback(async () => {
    if (!effectiveNovelId) return
    try {
      await indexNovelAssets(effectiveNovelId)
    } catch (e) {
      console.error('[force] reindex failed', e)
    }
  }, [effectiveNovelId])

  const startNew = () =>
    setEditing({ novelId: effectiveNovelId, type: 'other', name: '', description: '' })

  const save = async () => {
    if (!editing) return
    const payload = {
      name: editing.name?.trim() || '未命名势力',
      type: (editing.type ?? 'other') as ForceType,
      level: editing.level ?? '',
      description: editing.description ?? '',
      protagonistRelation: editing.protagonistRelation ?? '',
      coreMembers: editing.coreMembers ?? '',
      territory: editing.territory ?? '',
    }
    if (editing.id) {
      await forceService.update(editing.id, payload)
    } else {
      await forceService.create({ ...payload, novelId: effectiveNovelId })
    }
    await reindex()
    setEditing(null)
    load()
  }

  const remove = async (id: string) => {
    await forceService.delete(id)
    await reindex()
    load()
  }

  return (
    <div className="flex h-full">
      {/* 左：势力列表 */}
      <div className="w-56 border-r border-border/30 p-2 overflow-y-auto space-y-1">
        <button
          onClick={startNew}
          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-amber-500/15 text-amber-300 text-xs hover:bg-amber-500/25 transition-colors"
        >
          <Plus size={12} /> 新增势力
        </button>
        {loading && <div className="text-xs text-foreground/40 px-1 py-2">加载中…</div>}
        {!loading && items.length === 0 && (
          <div className="text-xs text-foreground/40 px-1 py-2">暂无势力设定</div>
        )}
        {items.map((f) => (
          <div
            key={f.id}
            className="group flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer"
            onClick={() => setEditing({ ...f })}
          >
            <div className="min-w-0">
              <div className="text-xs text-foreground truncate">{f.name}</div>
              <div className="text-[9px] text-amber-400/60">{typeLabel(f.type)}</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                remove(f.id)
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
            从左侧选择或新增一条势力设定。<br />
            势力信息会在写作时自动注入 AI 上下文，保持阵营与势力关系一致。
          </div>
        )}
        {editing && (
          <div className="space-y-3 max-w-2xl">
            <div className="flex items-center gap-2">
              <select
                value={editing.type ?? 'other'}
                onChange={(e) => setEditing({ ...editing, type: e.target.value as ForceType })}
                className="px-2 py-1.5 rounded bg-muted/50 border border-border/30 text-xs"
              >
                {FORCE_TYPES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <input
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="势力名称，如「天剑宗」"
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

            <div>
              <label className="text-[10px] text-foreground/50">等级/实力</label>
              <input
                value={editing.level ?? ''}
                onChange={(e) => setEditing({ ...editing, level: e.target.value })}
                placeholder="如「一流宗门」「三星战力」「帝国级」"
                className="w-full px-2 py-1.5 rounded bg-muted/30 border border-border/30 text-sm mt-0.5"
              />
            </div>

            <div>
              <label className="text-[10px] text-foreground/50">描述</label>
              <textarea
                value={editing.description ?? ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="势力的渊源、宗旨、行事风格、在剧情中的作用…"
                className="w-full h-32 px-3 py-2 rounded bg-muted/30 border border-border/30 text-sm leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/40 mt-0.5"
              />
            </div>

            <div>
              <label className="text-[10px] text-foreground/50">与主角关系</label>
              <input
                value={editing.protagonistRelation ?? ''}
                onChange={(e) => setEditing({ ...editing, protagonistRelation: e.target.value })}
                placeholder="如「敌对」「盟友」「主角所属」"
                className="w-full px-2 py-1.5 rounded bg-muted/30 border border-border/30 text-sm mt-0.5"
              />
            </div>

            <div>
              <label className="text-[10px] text-foreground/50">核心成员</label>
              <textarea
                value={editing.coreMembers ?? ''}
                onChange={(e) => setEditing({ ...editing, coreMembers: e.target.value })}
                placeholder="宗主、长老、代表人物等，每行一个"
                className="w-full h-24 px-3 py-2 rounded bg-muted/30 border border-border/30 text-sm leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-amber-500/40 mt-0.5"
              />
            </div>

            <div>
              <label className="text-[10px] text-foreground/50">领地/势力范围</label>
              <input
                value={editing.territory ?? ''}
                onChange={(e) => setEditing({ ...editing, territory: e.target.value })}
                placeholder="如「东域三郡」「昆仑山脉」"
                className="w-full px-2 py-1.5 rounded bg-muted/30 border border-border/30 text-sm mt-0.5"
              />
            </div>

            {editing.id && (
              <div className="flex justify-end">
                <button
                  onClick={() => remove(editing.id!)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-red-400/70 text-xs hover:bg-red-500/10"
                >
                  <Trash2 size={12} /> 删除此势力
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
