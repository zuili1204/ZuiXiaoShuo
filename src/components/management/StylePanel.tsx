import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Save, BookMarked, ExternalLink, Sparkles, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  clearStyleBinding,
  getStyleBinding,
  listStyleRecipes,
  saveStyleBinding,
} from '@/services/style-service'
import { loadMergedStyleForNovel } from '@/services/style-blend-service'
import { renderStylePrompt } from '@/services/style-prompt-service'
import type { MergedStyleProfile, StyleRecipe } from '@shared/style-types'
import { cn } from '@/utils/cn'
import { ActionLog } from '@/services/log-service'

export default function StylePanel({ novelId }: { novelId: string }) {
  const navigate = useNavigate()
  const [recipes, setRecipes] = useState<StyleRecipe[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [strength, setStrength] = useState('')
  const [merged, setMerged] = useState<MergedStyleProfile | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const refreshMerged = useCallback(async () => {
    try {
      setMerged(await loadMergedStyleForNovel(novelId))
    } catch {
      setMerged(null)
    }
  }, [novelId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, binding] = await Promise.all([listStyleRecipes(), getStyleBinding(novelId)])
      setRecipes(list)
      if (binding) {
        setRecipeId(binding.recipeId)
        setEnabled(binding.enabled)
        setStrength(binding.strengthOverride == null ? '' : String(binding.strengthOverride))
      } else {
        setRecipeId(list[0]?.id ?? '')
        setEnabled(false)
        setStrength('')
      }
      await refreshMerged()
    } finally {
      setLoading(false)
    }
  }, [novelId, refreshMerged])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!recipeId) {
      setMsg({ ok: false, text: '请先选择配方' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const override = strength.trim() === '' ? null : Math.max(0, Math.min(100, Number(strength)))
      await saveStyleBinding({
        novelId,
        recipeId,
        enabled,
        strengthOverride: override,
        updatedAt: new Date().toISOString(),
      })
      await refreshMerged()
      setMsg({ ok: true, text: enabled ? '已绑定文风，下次生成生效' : '已停用文风注入' })
      ActionLog.ui('style-binding', `${enabled ? '绑定' : '停用'}文风配方 ${recipeId}`)
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const unbind = async () => {
    setSaving(true)
    try {
      await clearStyleBinding(novelId)
      setEnabled(false)
      setRecipeId(recipes[0]?.id ?? '')
      setStrength('')
      setMerged(null)
      setMsg({ ok: true, text: '已解除文风绑定' })
    } catch (e) {
      setMsg({ ok: false, text: `解除失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setSaving(false)
    }
  }

  const current = recipes.find((r) => r.id === recipeId)
  const prompt = merged ? renderStylePrompt(merged) : null

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
        <Loader2 size={14} className="mr-2 animate-spin" />
        正在读取文风绑定…
      </div>
    )
  }

  return (
    <div className="space-y-4 px-3 py-3">
      {!recipes.length ? (
        <div className="rounded-lg border border-border/30 bg-muted/10 px-4 py-8 text-center text-[11px] leading-relaxed text-muted-foreground/70">
          <BookMarked size={24} className="mx-auto mb-2 text-muted-foreground/40" />
          还没有可用的融合配方。
          <br />
          先到文风库导入语料、生成画像并合成配方。
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => navigate('/styles')}>
              <ExternalLink size={12} className="mr-1" />
              打开文风库
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <label className="text-[11px] text-muted-foreground">选择配方</label>
            <select
              value={recipeId}
              onChange={(e) => { setRecipeId(e.target.value); setMsg(null) }}
              className="h-9 w-full rounded-lg border border-border/60 bg-muted/40 px-2 text-xs text-foreground focus:outline-none"
            >
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}（强度 {r.strength}）
                </option>
              ))}
            </select>
            {current && (
              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                {current.items.length} 个来源 · 锚点{current.anchorMode === 'excerpt' ? '摘录' : current.anchorMode === 'paraphrase' ? '改写' : '抽象'}
                {current.extraRules.length ? ` · ${current.extraRules.length} 条手写规则` : ''}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-primary" />
              生成本书时注入文风
            </label>
            <div className="ml-auto flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">强度覆盖</span>
              <Input
                type="number"
                min={0}
                max={100}
                value={strength}
                onChange={(e) => setStrength(e.target.value)}
                placeholder={current ? String(current.strength) : '默认'}
                className="h-7 w-16 px-1.5 text-center text-[11px]"
              />
            </div>
          </div>

          {msg && (
            <div className={cn('rounded-lg px-2.5 py-1.5 text-[11px]', msg.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
              {msg.text}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Save size={12} className="mr-1" />}
              保存绑定
            </Button>
            <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={unbind} disabled={saving}>
              解除绑定
            </Button>
          </div>

          {merged && (
            <section className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                <Sparkles size={12} className="text-primary" />
                融合预览
                <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                  置信度 {Math.round(merged.confidence * 100)}% · 强度 {merged.strength}
                </span>
              </div>
              <p className="text-[10px] leading-relaxed text-foreground/80">{merged.summary}</p>
              <div className="flex flex-wrap gap-1">
                {merged.mergedFrom.map((m) => (
                  <span key={m.sourceId} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    {m.name} ×{m.weight}
                  </span>
                ))}
              </div>
              {!!merged.conflicts.length && (
                <div className="space-y-1">
                  {merged.conflicts.map((c, i) => (
                    <div key={i} className="flex items-start gap-1 text-[10px] text-amber-400">
                      <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                      <span>{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
              {prompt && (
                <>
                  <button
                    onClick={() => setShowPrompt((v) => !v)}
                    className="text-[10px] text-primary hover:underline"
                  >
                    {showPrompt ? '收起提示词预览' : '查看注入的提示词'}
                  </button>
                  {showPrompt && (
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-background/60 px-2 py-1.5 text-[9px] leading-relaxed text-muted-foreground">
                      {prompt.text}
                    </pre>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}

      <div className="border-t border-border/20 pt-2">
        <Button size="sm" variant="ghost" onClick={() => navigate('/styles')}>
          <ExternalLink size={12} className="mr-1" />
          在文风库中管理来源与配方
        </Button>
      </div>
    </div>
  )
}
