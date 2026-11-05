import { useEffect, useMemo, useState } from 'react'
import { Plus, Save, Trash2, Loader2, SlidersHorizontal, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  deleteStyleRecipe,
  latestStyleProfile,
  newStyleRecipeId,
  saveStyleRecipe,
} from '@/services/style-service'
import type {
  StyleAnchorMode,
  StyleDimensionKey,
  StyleDimensionWeights,
  StyleProfile,
  StyleRecipe,
  StyleSource,
} from '@shared/style-types'
import { cn } from '@/utils/cn'

const DIMENSIONS: { key: StyleDimensionKey; label: string }[] = [
  { key: 'pov_tense', label: '人称与时态' },
  { key: 'syntax', label: '句法节奏' },
  { key: 'lexicon', label: '用词习惯' },
  { key: 'dialogue', label: '对话' },
  { key: 'description', label: '描写' },
  { key: 'interiority', label: '心理' },
  { key: 'humor_tone', label: '幽默与基调' },
  { key: 'characterization', label: '人物塑造' },
  { key: 'pacing_hooks', label: '节奏与钩子' },
  { key: 'chapter_engineering', label: '章节工程' },
  { key: 'hook_design', label: '钩子设计' },
  { key: 'relationship_engine', label: '关系引擎' },
  { key: 'setting_function', label: '设定功能' },
  { key: 'meta_humor', label: '元叙事与幽默' },
  { key: 'concreteness', label: '具体度' },
  { key: 'taboo_boundary', label: '禁忌边界' },
  { key: 'character_voice', label: '角色声音' },
]

interface ItemDraft {
  selected: boolean
  profileId: string
  weight: number
}

interface RecipeDraft {
  id: string
  name: string
  strength: number
  povPolicy: 'follow_novel' | 'follow_recipe'
  povOverride: '' | 'first' | 'third_limited' | 'third_omniscient' | 'mixed'
  anchorMode: StyleAnchorMode
  anchorBudget: number
  extraRules: string
  status: 'draft' | 'ready'
  items: Record<string, ItemDraft>
  dimWeights: Record<string, Record<string, string>>
}

function emptyDraft(): RecipeDraft {
  return {
    id: newStyleRecipeId(),
    name: '新文风配方',
    strength: 50,
    povPolicy: 'follow_novel',
    povOverride: '',
    anchorMode: 'excerpt',
    anchorBudget: 400,
    extraRules: '',
    status: 'ready',
    items: {},
    dimWeights: {},
  }
}

function fromRecipe(recipe: StyleRecipe): RecipeDraft {
  const items: Record<string, ItemDraft> = {}
  for (const item of recipe.items) {
    items[item.sourceId] = { selected: true, profileId: item.profileId, weight: item.weight }
  }
  const dimWeights: Record<string, Record<string, string>> = {}
  for (const [dim, bySource] of Object.entries(recipe.dimensionWeights ?? {})) {
    dimWeights[dim] = {}
    for (const [sourceId, value] of Object.entries(bySource ?? {})) {
      dimWeights[dim][sourceId] = String(value)
    }
  }
  return {
    id: recipe.id,
    name: recipe.name,
    strength: recipe.strength,
    povPolicy: recipe.povPolicy,
    povOverride: (recipe.povOverride ?? '') as RecipeDraft['povOverride'],
    anchorMode: recipe.anchorMode,
    anchorBudget: recipe.anchorBudget,
    extraRules: recipe.extraRules.join('\n'),
    status: recipe.status,
    items,
    dimWeights,
  }
}

export default function RecipeEditor({
  sources,
  recipes,
  onChanged,
}: {
  sources: StyleSource[]
  recipes: StyleRecipe[]
  onChanged: () => Promise<void> | void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(recipes[0]?.id ?? null)
  const [draft, setDraft] = useState<RecipeDraft>(() => (recipes[0] ? fromRecipe(recipes[0]) : emptyDraft()))
  const [profiles, setProfiles] = useState<Record<string, StyleProfile | null>>({})
  const [showWeights, setShowWeights] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const entries = await Promise.all(
        sources.map(async (s) => [s.id, await latestStyleProfile(s.id).catch(() => null)] as const),
      )
      if (!cancelled) setProfiles(Object.fromEntries(entries))
    }
    void load()
    return () => { cancelled = true }
  }, [sources])

  // 选中配方变化时载入表单；配方列表刷新后保持当前选中
  useEffect(() => {
    const recipe = recipes.find((r) => r.id === selectedId)
    if (recipe) setDraft(fromRecipe(recipe))
  }, [selectedId, recipes])

  const usableSources = useMemo(
    () => sources.filter((s) => {
      const p = profiles[s.id]
      return !!p && (p.status === 'ready' || p.status === 'stale')
    }),
    [sources, profiles],
  )

  const updateItem = (sourceId: string, patch: Partial<ItemDraft>) => {
    setDraft((d) => ({
      ...d,
      items: {
        ...d.items,
        [sourceId]: {
          selected: d.items[sourceId]?.selected ?? false,
          profileId: d.items[sourceId]?.profileId ?? profiles[sourceId]?.id ?? '',
          weight: d.items[sourceId]?.weight ?? 1,
          ...patch,
        },
      },
    }))
  }

  const toggleSource = (sourceId: string) => {
    const p = profiles[sourceId]
    if (!p) return
    updateItem(sourceId, {
      selected: !draft.items[sourceId]?.selected,
      profileId: p.id,
    })
  }

  const setDimWeight = (dim: string, sourceId: string, value: string) => {
    setDraft((d) => ({
      ...d,
      dimWeights: {
        ...d.dimWeights,
        [dim]: { ...(d.dimWeights[dim] ?? {}), [sourceId]: value },
      },
    }))
  }

  const save = async () => {
    const items = Object.entries(draft.items)
      .filter(([sourceId, item]) => item.selected && profiles[sourceId])
      .map(([sourceId, item]) => ({
        sourceId,
        profileId: profiles[sourceId]!.id,
        weight: Math.max(0, Number(item.weight) || 0),
      }))
    if (!items.length) {
      setMsg({ ok: false, text: '请至少选择一个已启用画像的来源' })
      return
    }
    const dimensionWeights: StyleDimensionWeights = {}
    for (const [dim, bySource] of Object.entries(draft.dimWeights)) {
      const entry: Record<string, number> = {}
      for (const [sourceId, raw] of Object.entries(bySource)) {
        if (!items.some((i) => i.sourceId === sourceId)) continue
        const num = Number(raw)
        if (raw.trim() !== '' && Number.isFinite(num) && num >= 0) entry[sourceId] = num
      }
      if (Object.keys(entry).length) dimensionWeights[dim as StyleDimensionKey] = entry
    }
    setBusy(true)
    setMsg(null)
    try {
      const recipe: StyleRecipe = {
        id: draft.id,
        name: draft.name.trim() || '未命名配方',
        strength: Math.max(0, Math.min(100, Math.round(draft.strength))),
        povPolicy: draft.povPolicy,
        povOverride: draft.povPolicy === 'follow_recipe' && draft.povOverride ? draft.povOverride : null,
        anchorMode: draft.anchorMode,
        anchorBudget: Math.max(0, Math.min(800, Math.round(draft.anchorBudget))),
        items,
        dimensionWeights,
        extraRules: draft.extraRules.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        overridesJson: {},
        status: 'ready',
        createdAt: '',
        updatedAt: '',
      }
      await saveStyleRecipe(recipe)
      await onChanged()
      setMsg({ ok: true, text: '配方已保存' })
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    const recipe = recipes.find((r) => r.id === draft.id)
    if (!recipe) return
    if (!window.confirm(`删除配方「${recipe.name}」？已绑定该配方的作品将自动停止注入文风。`)) return
    setBusy(true)
    try {
      await deleteStyleRecipe(recipe.id)
      setSelectedId(null)
      setDraft(emptyDraft())
      await onChanged()
    } catch (e) {
      setMsg({ ok: false, text: `删除失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setBusy(false)
    }
  }

  const startNew = () => {
    setSelectedId(null)
    setDraft(emptyDraft())
    setMsg(null)
  }

  const selectedSourceIds = Object.entries(draft.items).filter(([, i]) => i.selected).map(([id]) => id)

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border/20 flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">融合配方</div>
          <div className="text-[10px] text-muted-foreground">把多本书的文风按权重合成一个目标</div>
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={startNew}>
          <Plus size={12} className="mr-1" />
          新建
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {recipes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {recipes.map((r) => (
              <button
                key={r.id}
                onClick={() => { setSelectedId(r.id); setMsg(null) }}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                  draft.id === r.id
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/40 text-muted-foreground hover:bg-muted/20',
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <label className="text-[11px] text-muted-foreground">配方名称</label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">强度 {draft.strength}</label>
            <input
              type="range"
              min={0}
              max={100}
              value={draft.strength}
              onChange={(e) => setDraft({ ...draft, strength: Number(e.target.value) })}
              className="w-full accent-primary"
            />
            <p className="text-[10px] text-muted-foreground/60">
              {draft.strength <= 30 ? '轻微影响用词' : draft.strength <= 60 ? '接近正常风格约束' : draft.strength <= 80 ? '强约束，含量化目标' : '最高强度，谨慎使用'}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">人称策略</label>
            <select
              value={draft.povPolicy === 'follow_recipe' ? draft.povOverride || 'follow_novel' : 'follow_novel'}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'follow_novel') setDraft({ ...draft, povPolicy: 'follow_novel', povOverride: '' })
                else setDraft({ ...draft, povPolicy: 'follow_recipe', povOverride: v as RecipeDraft['povOverride'] })
              }}
              className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-xs text-foreground focus:outline-none"
            >
              <option value="follow_novel">跟随本书</option>
              <option value="first">第一人称</option>
              <option value="third_limited">第三人称限知</option>
              <option value="third_omniscient">第三人称全知</option>
              <option value="mixed">人称混用</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">锚点方式</label>
            <select
              value={draft.anchorMode}
              onChange={(e) => setDraft({ ...draft, anchorMode: e.target.value as StyleAnchorMode })}
              className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-xs text-foreground focus:outline-none"
            >
              <option value="excerpt">摘录原文片段</option>
              <option value="paraphrase">改写片段（避免抄袭）</option>
              <option value="abstract">只给抽象描述</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">锚点字数预算</label>
            <Input
              type="number"
              min={0}
              max={800}
              value={draft.anchorBudget}
              onChange={(e) => setDraft({ ...draft, anchorBudget: Number(e.target.value) })}
            />
          </div>
        </div>

        <section>
          <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">来源与权重</h4>
          {!usableSources.length && (
            <p className="rounded-lg bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-400">
              还没有可用画像。请先在「文风来源」中分析并启用至少一个来源。
            </p>
          )}
          <div className="space-y-1">
            {sources.map((s) => {
              const p = profiles[s.id]
              const usable = !!p && (p.status === 'ready' || p.status === 'stale')
              const item = draft.items[s.id]
              return (
                <div key={s.id} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-1.5', item?.selected ? 'border-primary/30 bg-primary/5' : 'border-border/20 bg-muted/5')}>
                  <input
                    type="checkbox"
                    checked={!!item?.selected}
                    disabled={!usable}
                    onChange={() => toggleSource(s.id)}
                    className="accent-primary"
                  />
                  <div className="min-w-0">
                    <div className="text-[11px] text-foreground truncate">{s.name}</div>
                    <div className="text-[9px] text-muted-foreground">
                      {usable ? `画像置信度 ${Math.round((p.confidence ?? 0) * 100)}%` : '尚无可用画像'}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <span className="text-[9px] text-muted-foreground">权重</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      step={0.5}
                      value={item?.weight ?? 1}
                      disabled={!item?.selected}
                      onChange={(e) => updateItem(s.id, { weight: Number(e.target.value) })}
                      className="h-6 w-12 rounded border border-border/40 bg-muted/30 px-1 text-center text-[10px] text-foreground focus:outline-none disabled:opacity-40"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        <section className="space-y-1">
          <label className="text-[11px] text-muted-foreground">作者指定规则（每行一条，优先于自动提取）</label>
          <Textarea
            value={draft.extraRules}
            onChange={(e) => setDraft({ ...draft, extraRules: e.target.value })}
            placeholder="例如：不写系统面板；对话后不解释潜台词"
            className="min-h-[64px] text-[11px]"
          />
        </section>

        <section>
          <button
            onClick={() => setShowWeights((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showWeights ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <SlidersHorizontal size={11} />
            按维度调整来源权重（可选）
          </button>
          {showWeights && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-border/30">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-border/30 bg-muted/20 text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">维度</th>
                    {selectedSourceIds.map((id) => (
                      <th key={id} className="max-w-[90px] truncate px-2 py-1 text-center font-medium">
                        {sources.find((s) => s.id === id)?.name ?? id}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DIMENSIONS.map((dim) => (
                    <tr key={dim.key} className="border-b border-border/15 last:border-0">
                      <td className="px-2 py-1 text-foreground/80">{dim.label}</td>
                      {selectedSourceIds.map((id) => (
                        <td key={id} className="px-1 py-1">
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.5}
                            value={draft.dimWeights[dim.key]?.[id] ?? ''}
                            placeholder="默认"
                            onChange={(e) => setDimWeight(dim.key, id, e.target.value)}
                            className="h-6 w-full rounded border border-border/40 bg-muted/30 px-1 text-center text-[10px] text-foreground focus:outline-none"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {msg && (
          <div className={cn('rounded-lg px-2.5 py-1.5 text-[11px]', msg.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
            {msg.text}
          </div>
        )}

        <div className="flex items-center gap-2 pb-4">
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Save size={12} className="mr-1" />}
            保存配方
          </Button>
          {recipes.some((r) => r.id === draft.id) && (
            <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={remove} disabled={busy}>
              <Trash2 size={12} className="mr-1" />
              删除
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
