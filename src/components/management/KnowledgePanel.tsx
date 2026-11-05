import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import {
  ChevronRight, FileText, Loader2, Search, RefreshCw, Edit3, Save, X,
  Database, BookOpen, Users, Globe, GitBranch, AlertCircle, Check, Sparkles,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { knowledgeService, type KBFileMeta, type KBSearchResult } from '@/services/knowledge-service'
import { volumeService, chapterService, characterService, worldviewService } from '@/services/data-service'
import { autoBuildKnowledgeBase, type AutoBuildProgress } from '@/services/kb-auto-build'

// Friendly labels for root files and directories
const FILE_LABELS: Record<string, string> = {
  'novel.md': '小说总览',
  'outline.md': '全书大纲',
  'arc.md': '爽点曲线',
  'foreshadowings.md': '伏笔账本',
  'hooks.md': '钩子地图',
}

const DIR_LABELS: Record<string, string> = {
  volumes: '卷概要',
  chapters: '章节简要',
  characters: '角色档案',
  worldviews: '世界观',
}

// KB 资产文件名多为 uuid（chapters/<id>.md、characters/<id>.md 等），
// 显示时映射为友好名（章节标题 / 角色名 / 卷名 / 世界观标题），映射不到时回退原名
function resolveLabel(path: string, idNames: Map<string, string>): string {
  const base = path.replace(/\.md$/, '')
  if (!base.includes('/')) return base
  const id = base.slice(base.indexOf('/') + 1)
  return idNames.get(id) || id
}

// ===== Tree building =====

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  children?: TreeNode[]
  meta?: KBFileMeta
}

function buildTree(files: KBFileMeta[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')
      if (isLast) {
        current.children = current.children || []
        current.children.push({ name: part, path, isDir: false, meta: f })
      } else {
        current.children = current.children || []
        let dir = current.children.find((c) => c.name === part && c.isDir)
        if (!dir) {
          dir = { name: part, path, isDir: true, children: [] }
          current.children.push(dir)
        }
        current = dir
      }
    }
  }
  // Sort: directories first, then files, alphabetically
  function sortNode(node: TreeNode) {
    if (!node.children) return
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children.forEach(sortNode)
  }
  sortNode(root)
  return root.children || []
}

// ===== Utilities =====

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  } catch {
    return ''
  }
}

// ===== Simple inline markdown renderer =====

function renderInline(text: string): ReactNode {
  if (!text) return text
  const parts: ReactNode[] = []
  let remaining = text
  let key = 0
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/
  while (remaining.length > 0) {
    const match = remaining.match(pattern)
    if (!match || match.index === undefined) {
      parts.push(remaining)
      break
    }
    if (match.index > 0) parts.push(remaining.slice(0, match.index))
    const token = match[0]
    if (token.startsWith('**')) {
      parts.push(<strong key={key++} className="font-semibold text-foreground">{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      parts.push(<code key={key++} className="bg-muted/30 px-1 rounded text-xs">{token.slice(1, -1)}</code>)
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>)
    }
    remaining = remaining.slice(match.index + token.length)
  }
  return <>{parts}</>
}

// ===== Markdown preview component =====

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split('\n')
  const elements: ReactNode[] = []
  let inFrontmatter = false
  let fmLines: string[] = []
  let inCode = false
  let codeLines: string[] = []
  let listItems: ReactNode[] = []
  let key = 0

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(<ul key={`ul-${key++}`} className="ml-4 space-y-0.5">{listItems}</ul>)
      listItems = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code block
    if (line.trim().startsWith('```')) {
      if (inCode) {
        elements.push(
          <pre key={`pre-${key++}`} className="bg-muted/30 rounded p-2 text-xs overflow-x-auto my-2">
            <code>{codeLines.join('\n')}</code>
          </pre>,
        )
        codeLines = []
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
      continue
    }

    // Frontmatter delimiter
    if (line.trim() === '---') {
      if (i === 0 && !inFrontmatter) {
        inFrontmatter = true
        continue
      }
      if (inFrontmatter) {
        elements.push(
          <div key={`fm-${key++}`} className="bg-muted/20 border border-border/30 rounded p-2 mb-2 text-[11px] font-mono text-muted-foreground/80 space-y-0.5">
            {fmLines.map((fl, fi) => <div key={fi}>{fl}</div>)}
          </div>,
        )
        fmLines = []
        inFrontmatter = false
        continue
      }
      // Horizontal rule
      flushList()
      elements.push(<hr key={`hr-${key++}`} className="border-border/30 my-2" />)
      continue
    }
    if (inFrontmatter) {
      fmLines.push(line)
      continue
    }

    // Headings
    if (line.startsWith('### ')) {
      flushList()
      elements.push(<h3 key={`h3-${key++}`} className="text-sm font-semibold text-foreground mt-3 mb-1">{renderInline(line.slice(4))}</h3>)
      continue
    }
    if (line.startsWith('## ')) {
      flushList()
      elements.push(<h2 key={`h2-${key++}`} className="text-base font-semibold text-foreground mt-3 mb-1">{renderInline(line.slice(3))}</h2>)
      continue
    }
    if (line.startsWith('# ')) {
      flushList()
      elements.push(<h1 key={`h1-${key++}`} className="text-lg font-bold text-foreground mt-3 mb-2">{renderInline(line.slice(2))}</h1>)
      continue
    }

    // List items
    if (/^[-*]\s/.test(line)) {
      listItems.push(<li key={`li-${key++}`} className="list-disc ml-4 text-sm text-muted-foreground">{renderInline(line.replace(/^[-*]\s/, ''))}</li>)
      continue
    }
    if (/^\d+\.\s/.test(line)) {
      listItems.push(<li key={`li-${key++}`} className="list-decimal ml-4 text-sm text-muted-foreground">{renderInline(line.replace(/^\d+\.\s/, ''))}</li>)
      continue
    }

    // Empty line
    if (line.trim() === '') {
      flushList()
      continue
    }

    // Regular paragraph
    flushList()
    elements.push(<p key={`p-${key++}`} className="text-sm text-muted-foreground leading-relaxed">{renderInline(line)}</p>)
  }

  // Flush remaining code block
  if (inCode && codeLines.length > 0) {
    elements.push(
      <pre key="pre-final" className="bg-muted/30 rounded p-2 text-xs overflow-x-auto my-2">
        <code>{codeLines.join('\n')}</code>
      </pre>,
    )
  }
  flushList()

  return <div className="space-y-1">{elements}</div>
}

// ===== Tree item component =====

function TreeItem({
  node,
  depth,
  expandedDirs,
  selectedPath,
  idNames,
  onSelect,
  onToggle,
}: {
  node: TreeNode
  depth: number
  expandedDirs: Set<string>
  selectedPath: string | null
  idNames: Map<string, string>
  onSelect: (path: string) => void
  onToggle: (path: string) => void
}) {
  const isExpanded = expandedDirs.has(node.path)
  const label = node.isDir
    ? DIR_LABELS[node.name] || node.name
    : FILE_LABELS[node.path] || resolveLabel(node.path, idNames)

  if (node.isDir) {
    return (
      <div>
        <button
          onClick={() => onToggle(node.path)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded hover:bg-muted/20 transition-colors text-left"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <ChevronRight
            size={12}
            className={cn('text-muted-foreground transition-transform flex-shrink-0', isExpanded && 'rotate-90')}
          />
          <span className="truncate">{label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">
            {node.children?.length || 0}
          </span>
        </button>
        {isExpanded && node.children?.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            selectedPath={selectedPath}
            idNames={idNames}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={cn(
        'w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded text-left transition-colors',
        'hover:bg-muted/20',
        selectedPath === node.path
          ? 'bg-primary/10 text-foreground'
          : 'text-muted-foreground',
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <FileText size={11} className="flex-shrink-0 opacity-60" />
      <span className="truncate">{label}</span>
    </button>
  )
}

// ===== Main component =====

export default function KnowledgePanel({ novelId }: { novelId: string }) {
  const [files, setFiles] = useState<KBFileMeta[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingContent, setIsLoadingContent] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<KBSearchResult | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [confirmingRebuild, setConfirmingRebuild] = useState(false)
  const [autoBuildProgress, setAutoBuildProgress] = useState<AutoBuildProgress | null>(null)
  const autoBuildAbortRef = useRef<AbortController | null>(null)
  // uuid → 友好名 映射（章节标题/卷名/角色名/世界观标题），用于树与搜索结果展示
  const [idNames, setIdNames] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    async function loadNames() {
      const map = new Map<string, string>()
      try {
        const vols = await volumeService.getByNovelId(novelId)
        for (const v of vols) {
          map.set(v.id, v.title)
          const chs = await chapterService.getByVolumeId(v.id)
          for (const c of chs) map.set(c.id, c.title)
        }
        const chars = await characterService.getByNovelId(novelId)
        for (const c of chars) map.set(c.id, c.name)
        const wvs = await worldviewService.getByNovelId(novelId)
        for (const w of wvs) map.set(w.id, w.title)
      } catch (e) {
        console.warn('Failed to load KB id-name map:', e)
      }
      if (!cancelled) setIdNames(map)
    }
    loadNames()
    return () => { cancelled = true }
  }, [novelId])

  const loadFiles = useCallback(async () => {
    setIsLoading(true)
    try {
      const list = await knowledgeService.listFiles(novelId)
      setFiles(list)
      // Auto-expand all directories
      const dirs = new Set<string>()
      for (const f of list) {
        const parts = f.path.split('/')
        if (parts.length > 1) dirs.add(parts[0])
      }
      setExpandedDirs(dirs)
      // Auto-select novel.md if nothing selected
      setSelectedPath((prev) => {
        if (prev) return prev
        const novelMd = list.find((f) => f.path === 'novel.md')
        return novelMd ? novelMd.path : list[0]?.path || null
      })
    } catch (err) {
      console.error('Failed to load KB files:', err)
      setError('加载知识库文件失败')
    } finally {
      setIsLoading(false)
    }
  }, [novelId])

  // Load file list on mount
  useEffect(() => {
    loadFiles()
  }, [novelId])

  // Load content when selected path changes
  useEffect(() => {
    if (!selectedPath) {
      setContent(null)
      return
    }
    let cancelled = false
    setIsLoadingContent(true)
    async function load() {
      try {
        const c = await knowledgeService.read(novelId, selectedPath!)
        if (!cancelled) {
          setContent(c)
          setIsEditing(false)
        }
      } catch (err) {
        console.error('Failed to read KB file:', err)
      } finally {
        if (!cancelled) setIsLoadingContent(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [novelId, selectedPath])

  const handleToggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleSave = async () => {
    if (!selectedPath) return
    setIsSaving(true)
    setError(null)
    try {
      await knowledgeService.write(novelId, selectedPath, editContent, 'manual-edit')
      setContent(editContent)
      setIsEditing(false)
      await loadFiles()
    } catch (err) {
      console.error('Failed to save:', err)
      setError('保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSync = async (type: 'outline' | 'characters' | 'worldviews' | 'foreshadowings') => {
    setActionLoading(type)
    setError(null)
    setSuccess(null)
    try {
      switch (type) {
        case 'outline': await knowledgeService.syncOutline(novelId); break
        case 'characters': await knowledgeService.syncCharacters(novelId); break
        case 'worldviews': await knowledgeService.syncWorldviews(novelId); break
        case 'foreshadowings': await knowledgeService.syncForeshadowings(novelId); break
      }
      await loadFiles()
      if (selectedPath) {
        const c = await knowledgeService.read(novelId, selectedPath)
        setContent(c)
        setIsEditing(false)
      }
      const labels: Record<string, string> = { outline: '大纲', characters: '角色', worldviews: '世界观', foreshadowings: '伏笔' }
      setSuccess(`同步${labels[type]}完成`)
    } catch (err) {
      console.error(`Sync ${type} failed:`, err)
      const labels: Record<string, string> = { outline: '大纲', characters: '角色', worldviews: '世界观', foreshadowings: '伏笔' }
      setError(`同步${labels[type]}失败`)
    } finally {
      setActionLoading(null)
    }
  }

  const handleRebuild = async () => {
    setConfirmingRebuild(false)
    setActionLoading('rebuild')
    setError(null)
    setSuccess(null)
    try {
      await knowledgeService.rebuildFromSQLite(novelId)
      await loadFiles()
      if (selectedPath) {
        const c = await knowledgeService.read(novelId, selectedPath)
        setContent(c)
        setIsEditing(false)
      }
      setSuccess('知识库重建完成')
    } catch (err) {
      console.error('Rebuild failed:', err)
      setError('知识库重建失败')
    } finally {
      setActionLoading(null)
    }
  }

  const handleAutoBuild = async () => {
    setActionLoading('autobuild')
    setAutoBuildProgress({ phase: 'chapter', index: 0, total: 0, message: '启动中...' })
    setError(null)
    setSuccess(null)
    const controller = new AbortController()
    autoBuildAbortRef.current = controller
    try {
      for await (const p of autoBuildKnowledgeBase(novelId, controller.signal)) {
        setAutoBuildProgress(p)
        if (p.phase === 'error') {
          setError(p.message || 'AI 构建失败')
          setActionLoading(null)
          setAutoBuildProgress(null)
          return
        }
        if (p.phase === 'done') {
          setSuccess(p.message || 'AI 构建完成')
        }
      }
      await loadFiles()
      if (selectedPath) {
        const c = await knowledgeService.read(novelId, selectedPath)
        setContent(c)
        setIsEditing(false)
      }
    } catch (err) {
      console.error('Auto build failed:', err)
      setError('AI 构建失败')
    } finally {
      setActionLoading(null)
      setAutoBuildProgress(null)
      autoBuildAbortRef.current = null
    }
  }

  const handleCancelAutoBuild = () => {
    autoBuildAbortRef.current?.abort()
    setActionLoading(null)
    setAutoBuildProgress(null)
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setIsSearching(true)
    setShowSearchResults(true)
    setError(null)
    try {
      const results = await knowledgeService.search(novelId, searchQuery, 'all')
      setSearchResults(results)
    } catch (err) {
      console.error('Search failed:', err)
      setError('搜索失败')
    } finally {
      setIsSearching(false)
    }
  }

  const handleSearchResultClick = (file: string) => {
    // Exact match
    if (files.some((f) => f.path === file)) {
      setSelectedPath(file)
    } else if (file.endsWith('/')) {
      // Directory prefix (from RAG results) - find first file in that directory
      const match = files.find((f) => f.path.startsWith(file))
      if (match) setSelectedPath(match.path)
    }
    setShowSearchResults(false)
  }

  const tree = buildTree(files)
  const selectedMeta = files.find((f) => f.path === selectedPath)

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center px-3 py-2.5 border-b border-border/30">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">知识库</span>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{files.length} 文件</span>
          <button
            onClick={loadFiles}
            className="p-0.5 hover:text-foreground transition-colors"
            title="刷新"
          >
            <RefreshCw size={10} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/20 flex-wrap">
        <button
          onClick={() => handleSync('outline')}
          disabled={actionLoading !== null}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/30',
            actionLoading === 'outline' && 'opacity-50',
          )}
        >
          {actionLoading === 'outline' ? <Loader2 size={10} className="animate-spin" /> : <BookOpen size={10} />}
          大纲
        </button>
        <button
          onClick={() => handleSync('characters')}
          disabled={actionLoading !== null}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/30',
            actionLoading === 'characters' && 'opacity-50',
          )}
        >
          {actionLoading === 'characters' ? <Loader2 size={10} className="animate-spin" /> : <Users size={10} />}
          角色
        </button>
        <button
          onClick={() => handleSync('worldviews')}
          disabled={actionLoading !== null}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/30',
            actionLoading === 'worldviews' && 'opacity-50',
          )}
        >
          {actionLoading === 'worldviews' ? <Loader2 size={10} className="animate-spin" /> : <Globe size={10} />}
          世界观
        </button>
        <button
          onClick={() => handleSync('foreshadowings')}
          disabled={actionLoading !== null}
          className={cn(
            'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/30',
            actionLoading === 'foreshadowings' && 'opacity-50',
          )}
        >
          {actionLoading === 'foreshadowings' ? <Loader2 size={10} className="animate-spin" /> : <GitBranch size={10} />}
          伏笔
        </button>
        {confirmingRebuild ? (
          <>
            <span className="text-[10px] text-amber-400 px-1">确认重建？将清空手动编辑</span>
            <button
              onClick={handleRebuild}
              disabled={actionLoading !== null}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors"
            >
              <Check size={10} />
              确认
            </button>
            <button
              onClick={() => setConfirmingRebuild(false)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-muted-foreground hover:bg-muted/30 transition-colors"
            >
              <X size={10} />
              取消
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmingRebuild(true)}
            disabled={actionLoading !== null}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
              'text-amber-500/80 hover:text-amber-400 hover:bg-amber-500/10',
              actionLoading === 'rebuild' && 'opacity-50',
            )}
          >
            {actionLoading === 'rebuild' ? <Loader2 size={10} className="animate-spin" /> : <Database size={10} />}
            重建
          </button>
        )}

        {/* AI 构建：逐章 LLM 提取 → 自动填充知识库 */}
        {actionLoading === 'autobuild' ? (
          <button
            onClick={handleCancelAutoBuild}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <X size={10} />
            停止
          </button>
        ) : (
          <button
            onClick={handleAutoBuild}
            disabled={actionLoading !== null}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded transition-colors',
              'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10',
            )}
          >
            <Sparkles size={10} />
            AI 构建
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索知识库..."
            className="w-28 px-1.5 py-0.5 text-[10px] bg-muted/20 border border-border/40 rounded focus:outline-none focus:border-primary/50"
          />
          <button
            onClick={handleSearch}
            disabled={isSearching}
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            {isSearching ? <Loader2 size={10} className="animate-spin" /> : <Search size={10} />}
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20 text-[10px] text-red-400">
          <AlertCircle size={10} />
          {error}
          <button onClick={() => setError(null)} className="ml-auto"><X size={10} /></button>
        </div>
      )}

      {/* Success message */}
      {success && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-[10px] text-emerald-400">
          <Check size={10} />
          {success}
          <button onClick={() => setSuccess(null)} className="ml-auto"><X size={10} /></button>
        </div>
      )}

      {/* AI build progress */}
      {autoBuildProgress && (
        <div className="px-3 py-2 bg-cyan-500/5 border-b border-cyan-500/20 text-[10px] text-cyan-300 space-y-1">
          <div className="flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" />
            {autoBuildProgress.phase === 'chapter' && autoBuildProgress.total > 0 && (
              <span>
                AI 提取 {autoBuildProgress.index + 1}/{autoBuildProgress.total}
                {autoBuildProgress.title ? `：${autoBuildProgress.title}` : ''}
                {autoBuildProgress.message ? ` — ${autoBuildProgress.message}` : ''}
              </span>
            )}
            {autoBuildProgress.phase === 'summary' && (
              <span>{autoBuildProgress.message || '正在生成全书概要...'}</span>
            )}
            {autoBuildProgress.phase === 'done' && (
              <span className="text-emerald-400">{autoBuildProgress.message}</span>
            )}
          </div>
          {autoBuildProgress.phase === 'chapter' && autoBuildProgress.total > 0 && (
            <div className="w-full h-1 bg-cyan-500/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan-500/50 rounded-full transition-all duration-300"
                style={{ width: `${((autoBuildProgress.index + 1) / autoBuildProgress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* File tree */}
        <div className="w-56 flex-shrink-0 border-r border-border/20 overflow-y-auto p-1">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
            </div>
          ) : tree.length === 0 ? (
            <div className="py-8 text-center">
              <FileText size={20} className="mx-auto text-muted-foreground/20 mb-2" />
              <p className="text-xs text-muted-foreground/60">知识库为空</p>
              <button onClick={handleRebuild} className="text-[10px] text-primary hover:underline mt-1">
                从 SQLite 重建
              </button>
            </div>
          ) : (
            tree.map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                expandedDirs={expandedDirs}
                selectedPath={selectedPath}
                idNames={idNames}
                onSelect={setSelectedPath}
                onToggle={handleToggleDir}
              />
            ))
          )}
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {showSearchResults && searchResults ? (
            <div className="flex-1 overflow-y-auto p-3">
              <div className="flex items-center gap-2 mb-3">
                <Search size={12} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">搜索结果：{searchResults.sources.length} 条</span>
                <button
                  onClick={() => setShowSearchResults(false)}
                  className="ml-auto p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X size={12} />
                </button>
              </div>
              {searchResults.sources.length === 0 ? (
                <p className="text-xs text-muted-foreground/60 text-center py-8">未找到匹配内容</p>
              ) : (
                <div className="space-y-2">
                  {searchResults.sources.map((src, i) => (
                    <button
                      key={i}
                      onClick={() => handleSearchResultClick(src.file)}
                      className="w-full text-left p-2 rounded bg-muted/20 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <FileText size={10} className="text-muted-foreground flex-shrink-0" />
                        <span className="text-xs font-medium text-foreground">{FILE_LABELS[src.file] || resolveLabel(src.file, idNames)}</span>
                        {src.lineNumber && (
                          <span className="text-[10px] text-muted-foreground/60">L{src.lineNumber}</span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 whitespace-pre-wrap">{src.snippet}</p>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.answer && searchResults.sources.length > 0 && (
                <div className="mt-4 p-2 rounded bg-muted/10 border border-border/20">
                  <p className="text-[10px] text-muted-foreground/60 mb-1">综合回答</p>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{searchResults.answer}</p>
                </div>
              )}
            </div>
          ) : selectedPath ? (
            <>
              {/* File meta bar */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20">
                <FileText size={12} className="text-muted-foreground flex-shrink-0" />
                <span className="text-xs text-foreground truncate">{FILE_LABELS[selectedPath] || resolveLabel(selectedPath, idNames)}</span>
                {selectedMeta && (
                  <span className="text-[10px] text-muted-foreground/60 ml-2 flex-shrink-0">
                    {selectedMeta.generator} · {formatDate(selectedMeta.updatedAt)} · {selectedMeta.size}B
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                  {isEditing ? (
                    <>
                      <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10 rounded transition-colors"
                      >
                        {isSaving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                        保存
                      </button>
                      <button
                        onClick={() => setIsEditing(false)}
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/30 rounded transition-colors"
                      >
                        <X size={10} />
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => { setEditContent(content || ''); setIsEditing(true) }}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded transition-colors"
                    >
                      <Edit3 size={10} />
                      编辑
                    </button>
                  )}
                </div>
              </div>

              {/* Content */}
              <div className={cn('flex-1 p-4', isEditing ? 'overflow-hidden flex flex-col' : 'overflow-y-auto')}>
                {isLoadingContent ? (
                  <div className="flex justify-center py-8">
                    <Loader2 size={16} className="animate-spin text-muted-foreground/50" />
                  </div>
                ) : isEditing ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full flex-1 p-2 text-xs font-mono bg-muted/10 border border-border/30 rounded resize-none focus:outline-none focus:border-primary/50"
                    autoFocus
                  />
                ) : content ? (
                  <MarkdownPreview content={content} />
                ) : (
                  <p className="text-xs text-muted-foreground/60 text-center py-8">文件为空或不存在</p>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              <div className="text-center">
                <FileText size={24} className="mx-auto text-muted-foreground/20 mb-2" />
                <p>选择一个文件查看内容</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
