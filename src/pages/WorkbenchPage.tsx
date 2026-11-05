import { useEffect, useRef, useCallback, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, X, BookOpen, BookMarked, Users, GitBranch, Workflow, Download, Search, Wrench, Wand2, Clapperboard, Globe, Sparkles, Library, Swords, AlertCircle, ListTree, Route, ShieldCheck, BarChart3 } from 'lucide-react'
import { useNovelStore, useWorkbenchStore } from '@/stores'
import { novelService, volumeService, chapterService } from '@/services/data-service'
import { exportNovel, exportAsFile, exportNovelDocx } from '@/services/export-service'
import { loadIndex, indexNovelAssets } from '@/services/rag-service'
import { scanKbSqliteConsistency } from '@/services/consistency-service'
import { useShortcut } from '@/hooks/useShortcut'
import SearchPanel from '@/components/search/SearchPanel'
import { cn } from '@/utils/cn'
import TitleBar from '@/components/layout/TitleBar'
import StatusBar from '@/components/layout/StatusBar'
import ChapterTree from '@/components/workbench/ChapterTree'
import DailyCockpit from '@/components/workbench/DailyCockpit'
import WritingEditor from '@/components/editor/WritingEditor'
import EditorToolDrawer from '@/components/editor/EditorToolDrawer'
import AiChatPanel from '@/components/ai/AiChatPanel'
import PipelinePanel from '@/components/ai/PipelinePanel'
import SkillPanel from '@/components/ai/SkillPanel'
import QualityGateCard from '@/components/ai/QualityGateCard'
import DerivativePanel from '@/components/workbench/DerivativePanel'
import CharacterPanel from '@/components/management/CharacterPanel'
import OutlinePanel from '@/components/management/OutlinePanel'
import TrackingPanel from '@/components/management/TrackingPanel'
import WorldviewPanel from '@/components/management/WorldviewPanel'
import ForcePanel from '@/components/management/ForcePanel'
import KnowledgePanel from '@/components/management/KnowledgePanel'
import IntegrityPanel from '@/components/management/IntegrityPanel'
import PlatformPanel from '@/components/management/PlatformPanel'
import StylePanel from '@/components/management/StylePanel'
import DirectorPanel from '@/components/ai/DirectorPanel'
import OutlineWizard from '@/components/management/OutlineWizard'
import RecalibrateDialog from '@/components/management/RecalibrateDialog'
import type { Chapter } from '@shared/types'
import { ActionLog } from '@/services/log-service'

type SheetType = 'knowledge' | 'outline' | 'character' | 'tracking' | 'worldview' | 'force' | 'style' | 'pipeline' | 'skill' | 'derivative' | 'director' | 'integrity' | 'platform' | null

const SHEET_CONFIG: Record<NonNullable<SheetType>, { title: string; icon: typeof BookOpen; fullWidth?: boolean }> = {
  knowledge: { title: '知识库', icon: Library },
  outline: { title: '大纲管理', icon: BookOpen },
  character: { title: '角色设定', icon: Users },
  tracking: { title: '创作追踪', icon: GitBranch },
  worldview: { title: '世界观设定', icon: Globe },
  force: { title: '势力设定', icon: Swords },
  style: { title: '文风绑定', icon: BookMarked },
  pipeline: { title: 'AI 流水线', icon: Workflow, fullWidth: true },
  skill: { title: 'AI+ 技能版图', icon: Wrench },
  derivative: { title: '衍生工坊', icon: Wand2 },
  director: { title: '导演编排', icon: Clapperboard, fullWidth: true },
  integrity: { title: '数据体检', icon: ShieldCheck },
  platform: { title: '发布与数据', icon: BarChart3 },
}

export default function WorkbenchPage() {
  const { novelId } = useParams<{ novelId: string }>()
  const navigate = useNavigate()
  const novels = useNovelStore((s) => s.novels)
  const setCurrentNovel = useNovelStore((s) => s.setCurrentNovel)

  const {
    leftPanelWidth, rightPanelWidth,
    isLeftCollapsed, isRightCollapsed,
    setLeftPanelWidth, setRightPanelWidth,
    toggleLeftCollapsed, toggleRightCollapsed,
    wordCount,
  } = useWorkbenchStore()

  const [showSheet, setShowSheet] = useState<SheetType>(null)
  // 8.13：大纲面板左侧的二级滑出层（向导 / 重订走向）。单一状态实现「已开向导再点重订走向 → 原位切换」
  const [subSheet, setSubSheet] = useState<'outline-wizard' | 'recalibrate' | null>(null)
  const [wizardChapterCount, setWizardChapterCount] = useState(0)
  const [outlineRefresh, setOutlineRefresh] = useState(0)
  const [isDraggingLeft, setIsDraggingLeft] = useState(false)
  const [isDraggingRight, setIsDraggingRight] = useState(false)
  const [totalWordCount, setTotalWordCount] = useState(0)
  const [activeForeshadowCount, setActiveForeshadowCount] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [consistencyWarn, setConsistencyWarn] = useState<string | null>(null)
  const [novelMissing, setNovelMissing] = useState(false)

  const selectChapter = useWorkbenchStore((s) => s.selectChapter)
  const hydrateLayout = useWorkbenchStore((s) => s.hydrateLayout)

  // P2-8：进入工作台时恢复上次的布局记忆（面板宽度/折叠状态，settings 表）
  useEffect(() => {
    hydrateLayout()
  }, [hydrateLayout])

  // 快捷键：Ctrl/⌘+F 全文搜索，Esc 关闭搜索
  useShortcut(
    {
      'mod+f': () => setSearchOpen(true),
      escape: () => setSearchOpen(false),
    },
    [setSearchOpen]
  )

  const handleJumpToChapter = (chapterId: string) => {
    // 通过 ChapterTree 的章节数据定位：直接从 DB 拉取章节以选中
    chapterService.getById(chapterId).then((ch) => {
      if (ch) selectChapter(ch)
    }).catch((e) => console.error('Jump to chapter failed:', e))
    setSearchOpen(false)
  }

  const novel = novels.find((n) => n.id === novelId)
  const addNovel = useNovelStore((s) => s.addNovel)

  // 观察项修复：刷新后直达工作台路由时 novels store 尚未加载（HomePage 未挂载），
  // 此前会误显「未找到该小说」。按路由参数单查 DB 补种；仅当 DB 也查无此书时才显示未找到。
  useEffect(() => {
    if (!novelId || novel) return
    let cancelled = false
    novelService.getById(novelId)
      .then((n) => {
        if (cancelled) return
        if (n) addNovel(n)
        else setNovelMissing(true)
      })
      .catch((e) => {
        console.error('Failed to load novel by id:', e)
        if (!cancelled) setNovelMissing(true)
      })
    return () => { cancelled = true }
  }, [novelId, novel, addNovel])

  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const chapterInfo = selectedChapter
    ? `第${selectedChapter.order}章 · ${selectedChapter.title}`
    : ''

  // Set current novel in store + 加载 RAG 索引
  useEffect(() => {
    if (novel) {
      setCurrentNovel(novel)
    }
    if (novelId) {
      loadIndex(novelId).catch((e) => console.error('Failed to load RAG index:', e))
      // 把世界观/角色/伏笔/章节摘要灌入 RAG（修复 G3：资产此前从未被索引）
      indexNovelAssets(novelId).catch((e) => console.error('Failed to index novel assets:', e))
      // P2-6：打开小说时做一次 KB/SQLite 一致性扫描，差异仅告警不阻断
      // 观察项修复：差异除落日志外同步进 UI 横幅（可关闭）
      scanKbSqliteConsistency(novelId)
        .then((r) => {
          if (!r.ok) {
            console.warn('[kb-consistency]', r.report)
            ActionLog.warn('kb-consistency', r.report)
            setConsistencyWarn(r.report)
          } else {
            setConsistencyWarn(null)
          }
        })
        .catch((e) => console.error('KB consistency scan failed:', e))
    }
  }, [novel, novelId, setCurrentNovel])

  // Load total word count from all chapters
  useEffect(() => {
    if (!novelId) return
    let cancelled = false
    async function loadStats() {
      try {
        const vols = await volumeService.getByNovelId(novelId!)
        let total = 0
        for (const vol of vols) {
          const chapters = await chapterService.getByVolumeId(vol.id)
          total += chapters.reduce((sum, ch) => sum + ch.wordCount, 0)
        }
        if (!cancelled) setTotalWordCount(total)

        // Load foreshadow count from tracking
        try {
          const exists = await window.electronAPI?.file.exists(`content/tracking/${novelId}.json`)
          if (exists) {
            const raw = await window.electronAPI!.file.read(`content/tracking/${novelId}.json`)
            const state = JSON.parse(raw)
            setActiveForeshadowCount(state.activeForeshadowings?.filter((f: any) => f.status !== 'resolved').length || 0)
          }
        } catch {}
      } catch (err) {
        console.error('Failed to load stats:', err)
      }
    }
    loadStats()
    return () => { cancelled = true }
  }, [novelId, wordCount]) // Recalculate when word count changes

  // Handle export
  const [exportFormat, setExportFormat] = useState<'md' | 'txt' | 'docx'>('md')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportRange, setExportRange] = useState<'all' | 'range'>('all')
  const [exportStart, setExportStart] = useState(1)
  const [exportEnd, setExportEnd] = useState(1)
  const [totalChapters, setTotalChapters] = useState(0)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  // 加载总章节数 + 关闭导出弹窗（点击外部）
  useEffect(() => {
    if (!novelId) return
    volumeService.getByNovelId(novelId).then(async (vols) => {
      let count = 0
      for (const v of vols) count += (await chapterService.getByVolumeId(v.id)).length
      setTotalChapters(count)
      setExportEnd(count)
    }).catch(() => {})
  }, [novelId, wordCount])

  useEffect(() => {
    if (!exportMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportMenuOpen])

  const handleExport = async (range: 'all' | { startChapter: number; endChapter: number }) => {
    if (!novel || !novelId) return
    setExportMenuOpen(false)
    const rangeDesc = range === 'all' ? '全部' : `第${range.startChapter}-${range.endChapter}章`
    ActionLog.export('start', `${novel.title} ${rangeDesc} (${exportFormat})`)
    try {
      const opts = { format: exportFormat, range }
      // DOCX 走二进制通道，md/txt 走文本
      const content = exportFormat === 'docx'
        ? await exportNovelDocx(novelId, opts)
        : await exportNovel(novelId, opts)
      const ext = exportFormat
      // D-T10-1：exportAsFile 返回是否真正落盘；用户取消保存对话框时记 canceled 而非 success
      const saved = await exportAsFile(content, `${novel.title}${range === 'all' ? '' : `_第${range.startChapter}-${range.endChapter}章`}.${ext}`, exportFormat)
      if (saved) {
        ActionLog.export('success', `${novel.title}${range === 'all' ? '' : `_${rangeDesc}`} (${exportFormat})`)
      } else {
        ActionLog.export('canceled', `${novel.title} ${rangeDesc} (用户取消保存)`)
      }
    } catch (err) {
      ActionLog.export('failed', String(err))
      console.error('Export failed:', err)
    }
  }

  // Resize handlers
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingLeft) {
      const w = e.clientX
      if (w > 150 && w < window.innerWidth - 400) {
        setLeftPanelWidth(w)
      }
    }
    if (isDraggingRight) {
      const w = window.innerWidth - e.clientX
      if (w > 200 && w < 700) {
        setRightPanelWidth(w)
      }
    }
  }, [isDraggingLeft, isDraggingRight, setLeftPanelWidth, setRightPanelWidth])

  const handleMouseUp = useCallback(() => {
    setIsDraggingLeft(false)
    setIsDraggingRight(false)
  }, [])

  useEffect(() => {
    if (isDraggingLeft || isDraggingRight) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDraggingLeft, isDraggingRight, handleMouseMove, handleMouseUp])

  if (!novel || !novelId) {
    // 路由参数为空，或 DB 单查确认无此书 → 显示未找到；否则为 store 尚未就绪，显示加载态
    if (!novelId || novelMissing) {
      return (
        <div className="h-screen flex flex-col bg-background">
          <TitleBar />
          <div className="flex-1 flex items-center justify-center pt-9">
            <div className="text-center">
              <p className="text-muted-foreground mb-4">未找到该小说</p>
              <button
                onClick={() => navigate('/')}
                className="text-primary hover:underline text-sm"
              >
                返回首页
              </button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="h-screen flex flex-col bg-background">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center pt-9">
          <p className="text-muted-foreground text-sm">正在打开小说…</p>
        </div>
      </div>
    )
  }

  const sheetConfig = showSheet ? SHEET_CONFIG[showSheet] : null

  const toggleSheet = (type: NonNullable<SheetType>) => {
    const opening = showSheet !== type
    ActionLog.ui('toggle-panel', `${SHEET_CONFIG[type].title} ${opening ? '打开' : '关闭'}`)
    setShowSheet(opening ? type : null)
    if (type !== 'outline') setSubSheet(null)
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      <TitleBar />

      {/* Toolbar */}
      <div className="h-10 flex items-center px-2 bg-sidebar border-b border-border/40 no-drag select-none mt-9">
        <button
          onClick={() => { ActionLog.nav('back-to-home', `退出作品: ${novel.title}`); setCurrentNovel(null); navigate('/') }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted/30 transition-colors"
        >
          <ArrowLeft size={14} />
          返回
        </button>
        <span className="mx-2 text-border/30">|</span>
        <span className="text-xs text-foreground font-medium">{novel.title}</span>
        <span className="text-[10px] text-muted-foreground ml-1">- 工作台</span>

        <div className="flex-1" />

        {/* Management buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => toggleSheet('knowledge')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'knowledge'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Library size={12} className="inline mr-1" />
            知识库
          </button>
          <button
            onClick={() => navigate(`/plan/${novelId}?from=workbench`)}
            className="px-2 py-1 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
            title="开书规划与大纲工作台"
          >
            <ListTree size={12} className="inline mr-1" />
            规划
          </button>
          <button
            onClick={() => toggleSheet('outline')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'outline'
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <BookOpen size={12} className="inline mr-1" />
            大纲
          </button>
          <button
            onClick={() => toggleSheet('character')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'character'
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Users size={12} className="inline mr-1" />
            设定
          </button>
          <button
            onClick={() => toggleSheet('tracking')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'tracking'
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <GitBranch size={12} className="inline mr-1" />
            追踪
          </button>
          <button
            onClick={() => toggleSheet('worldview')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'worldview'
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Globe size={12} className="inline mr-1" />
            世界观
          </button>
          <button
            onClick={() => toggleSheet('force')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'force'
                ? 'bg-amber-500/20 text-amber-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Swords size={12} className="inline mr-1" />
            势力
          </button>
          <button
            onClick={() => toggleSheet('style')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'style'
                ? 'bg-rose-500/20 text-rose-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
            title="绑定融合文风配方"
          >
            <BookMarked size={12} className="inline mr-1" />
            文风
          </button>
          <button
            onClick={() => toggleSheet('integrity')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'integrity'
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
            title="核对数据库与正文文件是否一致"
          >
            <ShieldCheck size={12} className="inline mr-1" />
            体检
          </button>
          <button
            onClick={() => toggleSheet('platform')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'platform'
                ? 'bg-sky-500/20 text-sky-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
            title="平台数据、存稿与系列"
          >
            <BarChart3 size={12} className="inline mr-1" />
            数据
          </button>

          <span className="mx-1 text-border/20">|</span>

          {/* Pipeline button */}
          <button
            onClick={() => toggleSheet('pipeline')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'pipeline'
                ? 'bg-purple-500/20 text-purple-400'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Workflow size={12} className="inline mr-1" />
            流水线
          </button>

          {/* Director button */}
          <button
            onClick={() => toggleSheet('director')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'director'
                ? 'bg-indigo-500/20 text-indigo-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Clapperboard size={12} className="inline mr-1" />
            导演
          </button>

          {/* Skill panel button */}
          <button
            onClick={() => toggleSheet('skill')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'skill'
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Wrench size={12} className="inline mr-1" />
            技能
          </button>

          {/* Derivative workshop button */}
          <button
            onClick={() => toggleSheet('derivative')}
            className={cn(
              'px-2 py-1 text-[10px] rounded transition-colors',
              showSheet === 'derivative'
                ? 'bg-sky-500/20 text-sky-300'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
            )}
          >
            <Wand2 size={12} className="inline mr-1" />
            衍生
          </button>

          {/* Export button with dropdown */}
          <div className="relative" ref={exportMenuRef}>
            <div className="flex items-center rounded hover:bg-muted/30 transition-colors">
              <button
                onClick={() => setExportMenuOpen(!exportMenuOpen)}
                className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground rounded-l flex items-center gap-1"
                title="导出小说"
              >
                <Download size={12} className="inline" />
                导出
              </button>
              <select
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as 'md' | 'txt' | 'docx')}
                className="h-full px-1 py-1 text-[10px] bg-transparent text-muted-foreground rounded-r focus:outline-none"
                title="导出格式"
              >
                <option value="md">MD</option>
                <option value="txt">TXT</option>
                <option value="docx">DOCX</option>
              </select>
            </div>

            {exportMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-card border border-border/40 rounded-lg shadow-2xl p-3 space-y-3">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">导出范围</div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                    <input
                      type="radio"
                      checked={exportRange === 'all'}
                      onChange={() => setExportRange('all')}
                      className="accent-primary"
                    />
                    全部 ({totalChapters} 章)
                  </label>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                    <input
                      type="radio"
                      checked={exportRange === 'range'}
                      onChange={() => setExportRange('range')}
                      className="accent-primary"
                    />
                    指定章节
                  </label>
                </div>

                {exportRange === 'range' && (
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>第</span>
                    <input
                      type="number"
                      min={1}
                      max={totalChapters}
                      value={exportStart}
                      onChange={(e) => setExportStart(Math.max(1, Math.min(totalChapters, Number(e.target.value))))}
                      className="w-12 px-1.5 py-0.5 bg-muted/20 border border-border/40 rounded text-center focus:outline-none focus:border-primary/50"
                    />
                    <span>章 至 第</span>
                    <input
                      type="number"
                      min={exportStart}
                      max={totalChapters}
                      value={exportEnd}
                      onChange={(e) => setExportEnd(Math.max(exportStart, Math.min(totalChapters, Number(e.target.value))))}
                      className="w-12 px-1.5 py-0.5 bg-muted/20 border border-border/40 rounded text-center focus:outline-none focus:border-primary/50"
                    />
                    <span>章</span>
                  </div>
                )}

                <button
                  onClick={() => {
                    if (exportRange === 'all') {
                      handleExport('all')
                    } else {
                      handleExport({ startChapter: exportStart, endChapter: exportEnd })
                    }
                  }}
                  className="w-full px-2 py-1.5 text-[10px] text-primary bg-primary/10 hover:bg-primary/20 rounded transition-colors font-medium"
                >
                  导出{exportRange === 'all' ? `全部 ${totalChapters} 章` : `第${exportStart}-${exportEnd}章`}
                </button>
              </div>
            )}
          </div>

          <span className="mx-1 text-border/20">|</span>

          {/* Search button */}
          <button
            onClick={() => setSearchOpen(true)}
            className="px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground rounded hover:bg-muted/30 transition-colors"
            title="全文搜索 (Ctrl+F)"
          >
            <Search size={12} className="inline mr-1" />
            搜索
          </button>
        </div>
      </div>

      {/* KB/SQLite 一致性告警横幅（P2-6 扫描有差异时显示，可关闭） */}
      {consistencyWarn && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 select-none">
          <AlertCircle size={12} className="flex-shrink-0" />
          <span className="truncate" title={consistencyWarn}>{consistencyWarn}</span>
          <button
            onClick={() => setConsistencyWarn(null)}
            className="ml-auto p-0.5 flex-shrink-0 hover:text-amber-100 transition-colors"
            title="关闭提醒"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* P0：日更驾驶舱（今日字数 / 连续天数 / 近 7 天 / 存稿 / 当前章与未来 3 章） */}
      <DailyCockpit novelId={novel.id} onOpenTracking={() => toggleSheet('tracking')} />

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Panel - Chapter Tree */}
        <div
          className={cn(
            'flex-shrink-0 bg-sidebar border-r border-border/40 overflow-hidden',
            'transition-all duration-300 ease-in-out'
          )}
          style={{ width: isLeftCollapsed ? 0 : leftPanelWidth }}
        >
          <ChapterTree novelId={novel.id} />
        </div>

        {/* Left Resizer */}
        {!isLeftCollapsed && (
          <div
            className="w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors flex-shrink-0 group"
            onMouseDown={() => setIsDraggingLeft(true)}
          >
            <div className="w-full h-full group-hover:bg-primary/20" />
          </div>
        )}

        {/* Left toggle when collapsed */}
        {isLeftCollapsed && (
          <button
            onClick={toggleLeftCollapsed}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-20 p-1.5 bg-sidebar border border-border rounded-r-md text-muted-foreground hover:text-foreground"
          >
            <PanelLeftOpen size={14} />
          </button>
        )}

        {/* Center - Writing Editor */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <WritingEditor novelId={novel.id} />
        </div>

        {/* Right Resizer */}
        {!isRightCollapsed && (
          <div
            className="w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary transition-colors flex-shrink-0 group"
            onMouseDown={() => setIsDraggingRight(true)}
          >
            <div className="w-full h-full group-hover:bg-primary/20" />
          </div>
        )}

        {/* Right Panel - AI Chat */}
        <div
          className={cn(
            'flex-shrink-0 bg-sidebar border-l border-border/40',
            'transition-all duration-300 ease-in-out'
          )}
          style={{ width: isRightCollapsed ? 0 : rightPanelWidth }}
        >
          <AiChatPanel novelId={novel.id} />
        </div>

        {/* Management / Pipeline Panel Sheet (slides in from right) */}
        <div
          className={cn(
            'absolute top-0 right-0 h-full z-30',
            'bg-card border-l border-border/40 shadow-2xl',
            'transition-all duration-250 ease-in-out overflow-hidden',
            showSheet
              ? (sheetConfig?.fullWidth ? 'w-full lg:w-[800px]' : 'w-[520px]')
              : 'w-0 border-l-0'
          )}
        >
          {showSheet && sheetConfig && (
            <div className="h-full flex flex-col">
              {/* Sheet header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 bg-sidebar">
                <div className="flex items-center gap-2">
                  <sheetConfig.icon size={14} className="text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">{sheetConfig.title}</span>
                </div>
                <button
                  onClick={() => { setShowSheet(null); setSubSheet(null) }}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Sheet content */}
              <div className="flex-1 overflow-hidden">
                {showSheet === 'knowledge' && <KnowledgePanel novelId={novelId} />}
                {showSheet === 'outline' && <OutlinePanel novelId={novelId} refreshSignal={outlineRefresh} onOpenWizard={(n) => { setWizardChapterCount(n); setSubSheet('outline-wizard') }} onOpenRecalibrate={() => setSubSheet('recalibrate')} />}
                {showSheet === 'character' && <CharacterPanel novelId={novelId} />}
                {showSheet === 'tracking' && <TrackingPanel novelId={novelId} />}
                {showSheet === 'worldview' && <WorldviewPanel novelId={novelId} />}
                {showSheet === 'force' && <ForcePanel novelId={novelId} />}
                {showSheet === 'style' && <StylePanel novelId={novelId} />}
                {showSheet === 'integrity' && <IntegrityPanel novelId={novelId} />}
                {showSheet === 'platform' && <PlatformPanel novelId={novelId} />}
                {showSheet === 'pipeline' && <PipelinePanel novelId={novelId} />}
                {showSheet === 'director' && <DirectorPanel novelId={novelId} />}
                {showSheet === 'skill' && <SkillPanel />}
                {showSheet === 'derivative' && <DerivativePanel novelId={novelId} />}
              </div>
            </div>
          )}
        </div>

        {/* 8.13：大纲二级滑出层（在主 sheet 左侧再滑出；向导/重订走向共用一层，切换即换内容） */}
        {showSheet === 'outline' && (
          <div
            className={cn(
              'absolute top-0 h-full z-30 right-[520px]',
              'bg-card border-l border-border/40 shadow-2xl',
              'transition-all duration-250 ease-in-out overflow-hidden',
              subSheet ? 'w-[min(620px,calc(100vw-540px))]' : 'w-0 border-l-0'
            )}
          >
            {subSheet && (
              <div className="h-full flex flex-col">
                {/* Sub-sheet header */}
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 bg-sidebar">
                  <div className="flex items-center gap-2">
                    {subSheet === 'outline-wizard'
                      ? <ListTree size={14} className="text-muted-foreground" />
                      : <Route size={14} className="text-muted-foreground" />}
                    <span className="text-xs font-medium text-foreground">
                      {subSheet === 'outline-wizard' ? '新建大纲向导' : '重订走向'}
                    </span>
                  </div>
                  <button
                    onClick={() => setSubSheet(null)}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Sub-sheet content */}
                <div className="flex-1 overflow-hidden">
                  {subSheet === 'outline-wizard' && (
                    <OutlineWizard
                      novelId={novelId}
                      existingChapters={wizardChapterCount}
                      onClose={() => setSubSheet(null)}
                      onApplied={() => setOutlineRefresh((k) => k + 1)}
                    />
                  )}
                  {subSheet === 'recalibrate' && (
                    <RecalibrateDialog
                      novelId={novelId}
                      onClose={() => setSubSheet(null)}
                      onApplied={() => setOutlineRefresh((k) => k + 1)}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 全文搜索抽屉 */}
        <SearchPanel
          novelId={novel.id}
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          onJump={handleJumpToChapter}
        />

        {/* 编辑器工具抽屉（历史版本 / AI 率检测） */}
        <EditorToolDrawer novelId={novel.id} />

        {/* P0：质量门禁状态卡（浮动于编辑器右下角） */}
        <QualityGateCard />
      </div>

      {/* Sidebar toggle buttons */}
      <div className="absolute bottom-2 left-2 z-10 flex gap-1 no-drag">
        <button
          onClick={toggleLeftCollapsed}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title={isLeftCollapsed ? '展开章节目录' : '折叠章节目录'}
        >
          {isLeftCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
        </button>
      </div>
      <div className="absolute bottom-2 right-2 z-10 flex gap-1 no-drag">
        <button
          onClick={toggleRightCollapsed}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title={isRightCollapsed ? '展开AI面板' : '折叠AI面板'}
        >
          {isRightCollapsed ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
        </button>
      </div>

      {/* Status Bar */}
      <StatusBar
        wordCount={wordCount}
        totalWordCount={totalWordCount}
        chapterInfo={chapterInfo}
        extra={activeForeshadowCount > 0 ? `伏笔:${activeForeshadowCount}条待回收` : undefined}
      />
    </div>
  )
}
