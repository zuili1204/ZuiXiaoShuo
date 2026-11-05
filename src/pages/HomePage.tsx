import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Search, BookOpen, BookMarked, MoreHorizontal, Trash2, X, Filter, Upload, Pencil, ScanSearch, ListTree } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNovelStore } from '@/stores'
import { useNovels, useCreateNovel, useDeleteNovel } from '@/hooks/useNovels'
import { ImportNovelDialog } from '@/components/home/ImportNovelDialog'
import { DeconstructDialog } from '@/components/home/DeconstructDialog'
import EditNovelDialog from '@/components/home/EditNovelDialog'
import { cn } from '@/utils/cn'
import { GENRE_OPTIONS, NOVEL_STATUS_OPTIONS, PLATFORM_OPTIONS } from '@shared/constants'
import TitleBar from '@/components/layout/TitleBar'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ActionLog } from '@/services/log-service'
import { Button } from '@/components/ui/button'
import { NOVEL_TEMPLATES, type NovelTemplate } from '@/config/novel-templates'
import { applyNovelTemplate, listUserTemplates } from '@/services/template-service'
import type { Novel } from '@shared/types'

export default function HomePage() {
  const navigate = useNavigate()
  const { setCurrentNovel } = useNovelStore()
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showDeconstructDialog, setShowDeconstructDialog] = useState(false)
  const [editingNovel, setEditingNovel] = useState<Novel | null>(null)

  // React Query: 从数据库加载小说列表
  const { data: novels = [], isLoading, isError, refetch } = useNovels()
  const createNovel = useCreateNovel()
  const deleteNovel = useDeleteNovel()

  const filteredNovels = useMemo(() => {
    return novels.filter((n) => {
      const matchesSearch = n.title.toLowerCase().includes(searchTerm.toLowerCase())
      const matchesGenre = !selectedGenre || n.genre.includes(selectedGenre)
      return matchesSearch && matchesGenre
    })
  }, [novels, searchTerm, selectedGenre])

  const recentNovels = useMemo(() => {
    return [...novels]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 3)
  }, [novels])

  const [applyingTemplate, setApplyingTemplate] = useState(false)
  // F4：用户模板（拆书产物），新建小说时与内置模板合并展示
  const [userTemplates, setUserTemplates] = useState<NovelTemplate[]>([])
  useEffect(() => {
    listUserTemplates().then(setUserTemplates).catch(() => setUserTemplates([]))
  }, [showDeconstructDialog])
  const allTemplates = useMemo(() => [...NOVEL_TEMPLATES, ...userTemplates], [userTemplates])

  const handleCreateNovel = async (
    data: { title: string; description: string; genre: string[]; platform: string },
    templateId: string | null
  ) => {
    ActionLog.novel('create', `标题="${data.title}", 题材=${data.genre.join('/') || '无'}, 平台=${data.platform || '无'}`)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const novel: Novel = {
      id,
      title: data.title,
      description: data.description,
      coverPath: null,
      genre: data.genre,
      targetPlatform: data.platform,
      status: 'planning',
      wordCount: 0,
      chapterCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await createNovel.mutateAsync(novel)
    // F3：选题模板 → 本地落库主线分卷/前三章骨架/角色/世界观（无 LLM，失败不挡建书）
    if (templateId) {
      const template = allTemplates.find((t) => t.id === templateId)
      if (template) {
        setApplyingTemplate(true)
        try {
          const r = await applyNovelTemplate(id, template)
          ActionLog.novel('template', `模板「${template.name}」已应用：${r.volumes} 卷 / ${r.chapters} 章 / ${r.characters} 角色 / ${r.worldviewEntries} 条设定`)
        } catch (e) {
          ActionLog.warn('template', `模板应用失败（书已创建）: ${String(e)}`)
        } finally {
          setApplyingTemplate(false)
        }
      }
    }
    setShowCreateDialog(false)
    // 新书先进入开书规划，而不是直接落到空编辑器
    navigate(`/plan/${id}?mode=new&from=home`)
  }

  const handleDeleteNovel = (id: string) => {
    deleteNovel.mutate(id)
  }

  const openNovel = (novel: Novel) => {
    ActionLog.novel('open', `进入作品: "${novel.title}" (id=${novel.id})`)
    setCurrentNovel(novel)
    if (novel.status === 'planning') navigate(`/plan/${novel.id}?from=home`)
    else navigate(`/workbench/${novel.id}`)
  }

  const openPlan = (novel: Novel) => {
    ActionLog.novel('open-plan', `进入规划页: "${novel.title}" (id=${novel.id})`)
    setCurrentNovel(novel)
    navigate(`/plan/${novel.id}?from=home`)
  }

  const handleImportSuccess = (novelId: string) => {
    setShowImportDialog(false)
    refetch()
  }

  const showRecentSection = searchTerm === '' && !selectedGenre && recentNovels.length > 0

  return (
    <div className="h-screen flex flex-col bg-background">
      <TitleBar />

      <div className="flex-1 overflow-y-auto pt-10 px-6 pb-8">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-8 mt-4">
            <div>
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">
                醉小说
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                AI 辅助长篇小说创作工具
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={() => navigate('/styles')} size="sm" variant="outline" className="border-[#2a2a2e] text-[#e0e0e6] hover:bg-[#1c1c20]">
                <BookMarked size={14} className="mr-1.5" />
                文风库
              </Button>
              <Button onClick={() => setShowDeconstructDialog(true)} size="sm" variant="outline" className="border-[#2a2a2e] text-[#e0e0e6] hover:bg-[#1c1c20]">
                <ScanSearch size={14} className="mr-1.5" />
                拆书分析
              </Button>
              <Button onClick={() => setShowImportDialog(true)} size="sm" variant="outline" className="border-[#2a2a2e] text-[#e0e0e6] hover:bg-[#1c1c20]">
                <Upload size={14} className="mr-1.5" />
                导入小说
              </Button>
              <Button onClick={() => setShowCreateDialog(true)} size="sm">
                <Plus size={16} className="mr-1.5" />
                新建小说
              </Button>
            </div>
          </div>

          {/* Loading State */}
          {isLoading && (
            <div className="space-y-10">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="rounded-xl p-5 h-[200px] bg-[#141416] border border-[#1e1e22] animate-pulse">
                    <div className="h-5 w-24 bg-[#1c1c20] rounded mb-3" />
                    <div className="h-3 w-full bg-[#1c1c20] rounded mb-2" />
                    <div className="h-3 w-2/3 bg-[#1c1c20] rounded mb-6" />
                    <div className="flex justify-between">
                      <div className="h-5 w-14 bg-[#1c1c20] rounded-full" />
                      <div className="h-5 w-10 bg-[#1c1c20] rounded" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error State */}
          {isError && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="h-12 w-12 rounded-full bg-[#ef4444]/20 flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-[#ef4444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-muted-foreground mb-2">加载失败</h3>
              <p className="text-sm text-muted-foreground/60 mb-4">无法从数据库加载小说数据</p>
              <Button onClick={() => refetch()} variant="outline">
                重新加载
              </Button>
            </div>
          )}

          {/* Content - only shown when not loading and not error */}
          {!isLoading && !isError && (
            <>
              {/* Recent Section */}
              <AnimatePresence>
                {showRecentSection && (
                  <motion.section
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-10"
                  >
                    <h2 className="text-xs font-semibold text-muted-foreground mb-4 uppercase tracking-widest">
                      最近创作
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {recentNovels.map((novel, i) => (
                        <motion.div
                          key={novel.id}
                          initial={{ opacity: 0, y: 12 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.06 }}
                        >
                          <NovelCardItem
                            novel={novel}
                            onClick={() => openNovel(novel)}
                            onPlan={() => openPlan(novel)}
                            onDelete={() => handleDeleteNovel(novel.id)}
                            onEdit={() => setEditingNovel(novel)}
                          />
                        </motion.div>
                      ))}
                    </div>
                  </motion.section>
                )}
              </AnimatePresence>

              {/* Search & Filter */}
              <div className="flex items-center gap-3 mb-6">
                <div className="relative flex-1 max-w-sm">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                  <Input
                    type="text"
                    placeholder="搜索小说..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-9 bg-muted/30"
                  />
                </div>

                <div className="flex items-center gap-1.5 overflow-x-auto">
                  <Filter size={13} className="text-muted-foreground/60 flex-shrink-0" />
                  {GENRE_OPTIONS.slice(0, 6).map((genre) => (
                    <button
                      key={genre}
                      onClick={() => setSelectedGenre(selectedGenre === genre ? null : genre)}
                      className={cn(
                        'flex-shrink-0 px-2.5 py-1 rounded-md text-xs transition-all duration-150',
                        selectedGenre === genre
                          ? 'bg-primary/20 text-primary border border-primary/30'
                          : 'bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent'
                      )}
                    >
                      {genre}
                    </button>
                  ))}
                  {selectedGenre && (
                    <button
                      onClick={() => setSelectedGenre(null)}
                      className="flex-shrink-0 p-1 rounded hover:bg-muted/40 text-muted-foreground"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* All Novels Grid */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                    全部小说 ({filteredNovels.length})
                  </h2>
                  {novels.length === 0 && (
                    <span className="text-xs text-muted-foreground/60">
                      还没有任何小说，点击上方按钮开始创作
                    </span>
                  )}
                </div>

                {filteredNovels.length === 0 && novels.length === 0 ? (
                  <EmptyState onCreateNew={() => setShowCreateDialog(true)} />
                ) : filteredNovels.length === 0 && novels.length > 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Search size={36} className="text-muted-foreground/20 mb-3" />
                    <p className="text-sm text-muted-foreground">没有找到匹配的小说</p>
                    <button
                      onClick={() => { setSearchTerm(''); setSelectedGenre(null) }}
                      className="text-xs text-primary mt-1 hover:underline"
                    >
                      清除筛选
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filteredNovels.map((novel) => (
                      <NovelCardItem
                        key={novel.id}
                        novel={novel}
                        onClick={() => openNovel(novel)}
                        onPlan={() => openPlan(novel)}
                        onDelete={() => handleDeleteNovel(novel.id)}
                        onEdit={() => setEditingNovel(novel)}
                      />
                    ))}
                    <CreateNewCard onClick={() => setShowCreateDialog(true)} />
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>

      {/* Create Dialog */}
      <AnimatePresence>
        {showCreateDialog && (
          <CreateNovelDialog
            onSubmit={handleCreateNovel}
            onClose={() => setShowCreateDialog(false)}
            isPending={createNovel.isPending || applyingTemplate}
            userTemplates={userTemplates}
          />
        )}
      </AnimatePresence>

      {/* Import Dialog */}
      <ImportNovelDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onSuccess={handleImportSuccess}
      />

      {/* F4 拆书分析 Dialog */}
      <DeconstructDialog
        open={showDeconstructDialog}
        onClose={() => setShowDeconstructDialog(false)}
      />

      {/* Edit Dialog */}
      {editingNovel && (
        <EditNovelDialog
          novel={editingNovel}
          onClose={() => setEditingNovel(null)}
        />
      )}
    </div>
  )
}

// Novel Card Component
function NovelCardItem({ novel, onClick, onPlan, onDelete, onEdit }: {
  novel: Novel
  onClick: () => void
  onPlan: () => void
  onDelete: () => void
  onEdit: () => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  const statusInfo = NOVEL_STATUS_OPTIONS.find(s => s.value === novel.status)!

  return (
    <div
      onClick={onClick}
      className={cn(
        'relative group cursor-pointer',
        'glass-card-hover',
        'rounded-xl p-5 h-[200px]',
        'flex flex-col justify-between'
      )}
    >
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu) }}
          className="p-1.5 rounded-md hover:bg-muted/60 text-muted-foreground transition-colors"
        >
          <MoreHorizontal size={14} />
        </button>
        {showMenu && (
          <div className="absolute right-0 top-8 w-32 py-1 rounded-lg bg-popover border border-border shadow-xl z-10 animate-scale-in">
            <button
              onClick={(e) => { e.stopPropagation(); onPlan(); setShowMenu(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
            >
              <ListTree size={12} />
              开书规划
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); setShowMenu(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted/60 transition-colors"
            >
              <Pencil size={12} />
              编辑
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); setShowMenu(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={12} />
              删除
            </button>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <BookOpen size={20} className="text-primary" />
          <h3 className="font-semibold text-foreground truncate">{novel.title}</h3>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {novel.description || '暂无简介'}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <Badge variant={novel.status === 'completed' ? 'success' : novel.status === 'planning' ? 'warning' : 'default'}>
          {statusInfo?.label || novel.status}
        </Badge>
        <div className="flex items-center gap-1">
          {novel.genre.slice(0, 2).map((g) => (
            <span key={g} className="px-1.5 py-0.5 rounded text-[10px] bg-muted/50 text-muted-foreground">{g}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// Create New Card
function CreateNewCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-3 h-[200px] rounded-xl',
        'border-2 border-dashed border-border/30',
        'hover:border-primary/30 hover:bg-primary/[0.02]',
        'transition-all duration-200 group'
      )}
    >
      <div className={cn(
        'w-12 h-12 rounded-full flex items-center justify-center',
        'bg-muted/20 group-hover:bg-primary/10 transition-colors'
      )}>
        <Plus size={24} className="text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
      <span className="text-sm text-muted-foreground group-hover:text-primary/80 transition-colors">
        新建小说
      </span>
    </button>
  )
}

// Empty State
function EmptyState({ onCreateNew }: { onCreateNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <BookOpen size={48} className="text-muted-foreground/20 mb-4" />
      <h3 className="text-lg font-medium text-muted-foreground mb-2">还没有小说</h3>
      <p className="text-sm text-muted-foreground/60 mb-6 max-w-sm">
        点击下方按钮创建你的第一部作品，或导入已有的 txt/md 文件，让 AI 助你展开创作之旅
      </p>
      <Button onClick={onCreateNew}>
        <Plus size={16} className="mr-2" />
        创建第一部小说
      </Button>
    </div>
  )
}

// Create Novel Dialog
function CreateNovelDialog({ onSubmit, onClose, isPending, userTemplates }: {
  onSubmit: (data: { title: string; description: string; genre: string[]; platform: string }, templateId: string | null) => void
  onClose: () => void
  isPending: boolean
  userTemplates: NovelTemplate[]
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [genre, setGenre] = useState<string[]>([])
  const [platform, setPlatform] = useState('')
  // F3：起点模板（null = 空白开始，默认）
  const [templateId, setTemplateId] = useState<string | null>(null)

  // F4：内置模板 + 用户模板（拆书产物）合并；拆书模板标「拆书」角标
  const allTemplates = useMemo(() => [...NOVEL_TEMPLATES, ...userTemplates], [userTemplates])
  const isUserTpl = (t: NovelTemplate) => !NOVEL_TEMPLATES.some((b) => b.id === t.id)

  // 已选题材可过滤模板：选了题材只显示贴合的模板，没选显示全部
  const visibleTemplates = genre.length
    ? allTemplates.filter((t) => t.genres.some((g) => genre.includes(g)))
    : allTemplates

  // 题材变化后当前选中模板可能不在过滤结果里，回落空白开始
  useEffect(() => {
    if (templateId && !visibleTemplates.some((t) => t.id === templateId)) {
      setTemplateId(null)
    }
  }, [templateId, visibleTemplates])

  const selectedTemplate = templateId ? allTemplates.find((t) => t.id === templateId) ?? null : null

  const pickTemplate = (id: string | null) => {
    setTemplateId(id)
    if (id) {
      const t = allTemplates.find((x) => x.id === id)
      if (!t) return
      // 自动补全但绝不覆盖用户已输入的内容
      if (!description.trim()) setDescription(t.descriptionExample)
      setGenre((prev) => Array.from(new Set([...prev, ...t.genres])))
    }
  }

  const toggleGenre = (g: string) => {
    setGenre((prev) => prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g])
  }

  const handleSubmit = () => {
    if (title.trim()) {
      onSubmit({ title: title.trim(), description, genre, platform }, templateId)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        className="w-[520px] bg-card border border-border rounded-xl shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-5">创建新小说</h2>

        <div className="space-y-4">
          {/* F3：起点模板条 */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">从模板开始（可选）</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => pickTemplate(null)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs transition-all duration-150',
                  templateId === null
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-muted/20 text-muted-foreground border border-transparent hover:border-border/40'
                )}
              >
                空白开始
              </button>
              {visibleTemplates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => pickTemplate(t.id)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs transition-all duration-150',
                    templateId === t.id
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-muted/20 text-muted-foreground border border-transparent hover:border-border/40'
                  )}
                >
                  {t.name}
                  {isUserTpl(t) && <span className="ml-1 text-[10px] text-[#a5b4fc]">拆书</span>}
                </button>
              ))}
            </div>
            {selectedTemplate && (
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
                {selectedTemplate.blurb}。将自动搭好主线分卷、前 3 章骨架、角色与世界观，全部可改。
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              书名 <span className="text-red-400">*</span>
            </label>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入小说名称..."
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">简介</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简要描述你的故事背景和主线..."
              rows={3}
              className={cn(
                'w-full px-3 py-2 rounded-lg resize-none',
                'bg-muted/30 border border-border/60',
                'text-sm text-foreground placeholder:text-muted-foreground/50',
                'focus:outline-none focus:ring-2 focus:ring-primary/20'
              )}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">题材</label>
            <div className="flex flex-wrap gap-1.5">
              {GENRE_OPTIONS.slice(0, 8).map((g) => (
                <button
                  key={g}
                  onClick={() => toggleGenre(g)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs transition-all duration-150',
                    genre.includes(g)
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-muted/20 text-muted-foreground border border-transparent hover:border-border/40'
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">目标平台</label>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORM_OPTIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPlatform(p === platform ? '' : p)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs transition-all duration-150',
                    platform === p
                      ? 'bg-primary/20 text-primary border border-primary/30'
                      : 'bg-muted/20 text-muted-foreground border border-transparent hover:border-border/40'
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!title.trim() || isPending}>
            {isPending ? '创建中...' : '创建'}
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
