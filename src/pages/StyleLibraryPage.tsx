import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BookMarked, Plus, Trash2, Loader2, Library, Layers } from 'lucide-react'
import TitleBar from '@/components/layout/TitleBar'
import ImportCorpusDialog from '@/components/style/ImportCorpusDialog'
import StyleProfileView from '@/components/style/StyleProfileView'
import RecipeEditor from '@/components/style/RecipeEditor'
import { Button } from '@/components/ui/button'
import {
  deleteStyleSource,
  listStyleProfiles,
  listStyleRecipes,
  listStyleSources,
  updateStyleProfileStatus,
} from '@/services/style-service'
import { analyzeStyleSource } from '@/services/style-analysis-service'
import type { StyleProfile, StyleRecipe, StyleSource } from '@shared/style-types'
import { cn } from '@/utils/cn'
import { ActionLog } from '@/services/log-service'

const KIND_LABEL: Record<string, string> = {
  single_file: '整本',
  chapter_dir: '目录',
  paste: '粘贴',
  deconstruct: '拆书',
}
const STATUS_LABEL: Record<string, string> = {
  imported: '待分析',
  analyzing: '分析中',
  ready: '可用',
  failed: '失败',
}

export default function StyleLibraryPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'sources' | 'recipes'>('sources')
  const [sources, setSources] = useState<StyleSource[]>([])
  const [recipes, setRecipes] = useState<StyleRecipe[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [profiles, setProfiles] = useState<StyleProfile[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadSources = useCallback(async () => {
    const list = await listStyleSources()
    setSources(list)
    setSelectedId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null))
    return list
  }, [])

  const loadRecipes = useCallback(async () => {
    setRecipes(await listStyleRecipes())
  }, [])

  useEffect(() => {
    Promise.all([loadSources(), loadRecipes()]).finally(() => setLoading(false))
  }, [loadSources, loadRecipes])

  useEffect(() => {
    let cancelled = false
    if (!selectedId) {
      setProfiles([])
      return
    }
    listStyleProfiles(selectedId)
      .then((rows) => { if (!cancelled) setProfiles(rows) })
      .catch(() => { if (!cancelled) setProfiles([]) })
    return () => { cancelled = true }
  }, [selectedId])

  const selected = sources.find((s) => s.id === selectedId) ?? null

  const refreshProfiles = useCallback(async (sourceId: string) => {
    setProfiles(await listStyleProfiles(sourceId))
    await loadSources()
  }, [loadSources])

  const handleImported = async (source: StyleSource) => {
    ActionLog.ui('style-import', `导入文风来源: ${source.name}`)
    await loadSources()
    setSelectedId(source.id)
    setTab('sources')
  }

  const handleAnalyze = async () => {
    if (!selected || analyzing) return
    setAnalyzing(true)
    setProgress('正在准备…')
    try {
      const profile = await analyzeStyleSource(selected.id, {
        onProgress: (p) => setProgress(p.message || p.phase),
      })
      await refreshProfiles(selected.id)
      const sampled = (profile.metrics as { sampled?: { failed?: boolean }[] }).sampled ?? []
      const failed = sampled.filter((s) => s.failed).length
      setProgress(
        failed
          ? `分析完成，${failed} 章未能分析，已用其余章节生成画像`
          : '分析完成，请审阅后启用',
      )
      window.setTimeout(() => setProgress(null), 3000)
    } catch (e) {
      setProgress(`分析失败：${(e as Error)?.message || '未知错误'}`)
      // 失败时同步来源状态，避免列表仍显示“分析中”
      await refreshProfiles(selected.id).catch(() => {})
    } finally {
      setAnalyzing(false)
    }
  }

  const handleActivate = async (profile: StyleProfile) => {
    await updateStyleProfileStatus(profile.id, 'ready')
    // 同一来源只保留一个启用版本，避免新建配方取到旧版本
    for (const p of profiles) {
      if (p.id !== profile.id && p.status === 'ready') {
        await updateStyleProfileStatus(p.id, 'stale')
      }
    }
    await refreshProfiles(profile.sourceId)
    ActionLog.ui('style-activate', `启用画像 v${profile.version}（${selected?.name ?? profile.sourceId}）`)
  }

  const handleDelete = async (source: StyleSource) => {
    if (!window.confirm(`删除语料「${source.name}」及其画像？引用它的配方会跳过该来源。`)) return
    await deleteStyleSource(source.id)
    await loadSources()
    await loadRecipes()
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <TitleBar />

      <div className="flex-1 flex flex-col overflow-hidden mt-9">
        <div className="border-b border-border/40 bg-sidebar">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-6 py-3">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft size={14} />
              返回首页
            </button>
            <span className="text-border/30">|</span>
            <BookMarked size={15} className="text-primary" />
            <div>
              <div className="text-sm font-medium text-foreground">文风库</div>
              <div className="text-[10px] text-muted-foreground">学习表达方式，融合成作品专属文风</div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex rounded-lg border border-border/40 bg-muted/20 p-0.5">
                <button
                  onClick={() => setTab('sources')}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] transition-colors',
                    tab === 'sources' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Library size={12} />
                  文风来源
                </button>
                <button
                  onClick={() => setTab('recipes')}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] transition-colors',
                    tab === 'recipes' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Layers size={12} />
                  融合配方
                </button>
              </div>
              <Button size="sm" onClick={() => setImportOpen(true)}>
                <Plus size={13} className="mr-1" />
                导入语料
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          <div className="mx-auto flex h-full max-w-7xl">
            {loading ? (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                <Loader2 size={16} className="mr-2 animate-spin" />
                正在读取文风库…
              </div>
            ) : tab === 'sources' ? (
              <>
                <aside className="flex w-72 flex-shrink-0 flex-col border-r border-border/30">
                  <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    语料来源（{sources.length}）
                  </div>
                  <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
                    {sources.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => setSelectedId(s.id)}
                        className={cn(
                          'group w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                          s.id === selectedId
                            ? 'border-primary/30 bg-primary/5'
                            : 'border-transparent hover:border-border/30 hover:bg-muted/20',
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] text-foreground">{s.name}</span>
                          <span className={cn(
                            'ml-auto flex-shrink-0 rounded px-1 py-0.5 text-[9px]',
                            s.status === 'ready' ? 'bg-emerald-500/15 text-emerald-400'
                              : s.status === 'failed' ? 'bg-red-500/15 text-red-400'
                                : 'bg-white/5 text-muted-foreground',
                          )}>
                            {STATUS_LABEL[s.status] ?? s.status}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span>{KIND_LABEL[s.kind] ?? s.kind}</span>
                          <span>·</span>
                          <span>{s.chapterCount} 章</span>
                          <span>·</span>
                          <span>{s.charCount.toLocaleString()} 字</span>
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); void handleDelete(s) }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void handleDelete(s) } }}
                            className="ml-auto rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                            title="删除来源"
                          >
                            <Trash2 size={10} />
                          </span>
                        </div>
                      </button>
                    ))}
                    {!sources.length && (
                      <div className="px-3 py-12 text-center text-[11px] leading-relaxed text-muted-foreground/60">
                        还没有语料。
                        <br />
                        点击右上角「导入语料」开始。
                      </div>
                    )}
                  </div>
                </aside>

                <main className="min-w-0 flex-1">
                  {selected ? (
                    <StyleProfileView
                      source={selected}
                      profiles={profiles}
                      analyzing={analyzing}
                      progress={progress}
                      onAnalyze={handleAnalyze}
                      onActivate={handleActivate}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center text-xs text-muted-foreground/60">
                      <Library size={30} className="mb-3 text-muted-foreground/30" />
                      选择左侧来源，或先导入一本喜欢的小说
                    </div>
                  )}
                </main>
              </>
            ) : (
              <main className="min-w-0 flex-1">
                <RecipeEditor
                  sources={sources}
                  recipes={recipes}
                  onChanged={async () => { await loadRecipes(); await loadSources() }}
                />
              </main>
            )}
          </div>
        </div>
      </div>

      <ImportCorpusDialog open={importOpen} onOpenChange={setImportOpen} onImported={handleImported} />
    </div>
  )
}
