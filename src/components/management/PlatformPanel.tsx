import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Archive, ArrowRight, BarChart3, CalendarClock, CheckCircle2, ClipboardCopy,
  FileDown, Layers, Loader2, MessageSquare, Minus, RefreshCw, Send, TrendingDown, TrendingUp, Upload,
} from 'lucide-react'
import { useNovelStore, useWorkbenchStore } from '@/stores'
import { chapterService } from '@/services/data-service'
import {
  analyzePlatform,
  bindChapter,
  buildPlatformExport,
  clearPlatformData,
  importChapterCsv,
  importCommentsCsv,
  importDailyCsv,
  listLocalChapters,
  listPlatforms,
  saveDailyMetric,
  type LocalChapterRef,
} from '@/services/platform-service'
import {
  autoPlanStock,
  getPublishOverview,
  getReadyText,
  markPublished,
  savePublishPlan,
} from '@/services/publish-service'
import { listAllBooks, listSeriesForNovel, setNovelSeries } from '@/services/series-service'
import type {
  ImportResult,
  PlatformAnalysis,
  PublishOverview,
  SeriesBook,
  SeriesGroup,
  UnmappedChapter,
} from '@shared/platform-types'
import { cn } from '@/utils/cn'

type Tab = 'trend' | 'import' | 'publish' | 'series'
type ImportKind = 'daily' | 'chapter' | 'comment'

const TABS: { key: Tab; label: string; icon: typeof BarChart3 }[] = [
  { key: 'trend', label: '趋势与异常', icon: BarChart3 },
  { key: 'import', label: '数据导入', icon: Upload },
  { key: 'publish', label: '存稿与发布', icon: Send },
  { key: 'series', label: '系列', icon: Layers },
]

const IMPORT_KINDS: { key: ImportKind; label: string; hint: string; sample: string }[] = [
  {
    key: 'daily',
    label: '每日数据',
    hint: '每行一天：日期、阅读、读完率、评论、收益。支持 2026-11-01、11/1 与 62% / 0.62。',
    sample: '日期,阅读,读完率,评论,收益\n2026-11-01,12000,68%,86,35.5\n2026-11-02,13500,66%,102,41',
  },
  {
    key: 'chapter',
    label: '章节数据',
    hint: '每行一章：章节名、章节序号、阅读、读完率、评论、收益。导入后会自动尝试对应本地章节。',
    sample: '章节,章节序号,阅读,读完率,评论,收益\n回到那一年,1,18000,72%,120,52\n雨夜来客,2,16500,58%,90,44',
  },
  {
    key: 'comment',
    label: '评论',
    hint: '每行一条：日期、章节名、评论内容。只做本地情绪统计，不外传。',
    sample: '日期,章节,内容\n2026-11-01,回到那一年,开头很抓人，追了\n2026-11-02,雨夜来客,这章有点水，看得有点无聊',
  },
]

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function tomorrowKey(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatNumber(n: number): string {
  return Number(n || 0).toLocaleString()
}

function directionMeta(direction: PlatformAnalysis['trend']['direction']) {
  if (direction === 'up') return { icon: TrendingUp, text: '上升', className: 'text-emerald-400' }
  if (direction === 'down') return { icon: TrendingDown, text: '下降', className: 'text-rose-400' }
  return { icon: Minus, text: '持平', className: 'text-muted-foreground' }
}

export default function PlatformPanel({ novelId }: { novelId: string }) {
  const novel = useNovelStore((s) => s.novels.find((n) => n.id === novelId))
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)

  const [tab, setTab] = useState<Tab>('trend')
  const [platform, setPlatform] = useState(novel?.targetPlatform || '默认平台')
  const [platforms, setPlatforms] = useState<string[]>([])
  const [analysis, setAnalysis] = useState<PlatformAnalysis | null>(null)
  const [overview, setOverview] = useState<PublishOverview | null>(null)
  const [chapters, setChapters] = useState<LocalChapterRef[]>([])
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 导入
  const [importKind, setImportKind] = useState<ImportKind>('daily')
  const [csvText, setCsvText] = useState('')
  const [importing, setImporting] = useState(false)
  const [lastImport, setLastImport] = useState<ImportResult | null>(null)
  const [unmapped, setUnmapped] = useState<UnmappedChapter[]>([])
  const [bindDrafts, setBindDrafts] = useState<Record<string, string>>({})

  // 手动录入
  const [dailyDate, setDailyDate] = useState(todayKey())
  const [dailyReads, setDailyReads] = useState('')
  const [dailyRate, setDailyRate] = useState('')
  const [dailyComments, setDailyComments] = useState('')
  const [dailyRevenue, setDailyRevenue] = useState('')

  // 发布
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({})
  const [autoStart, setAutoStart] = useState(tomorrowKey())
  const [autoPerDay, setAutoPerDay] = useState('1')

  // 系列
  const [seriesName, setSeriesName] = useState('')
  const [seriesOrder, setSeriesOrder] = useState('0')
  const [series, setSeries] = useState<SeriesGroup | null>(null)
  const [allBooks, setAllBooks] = useState<SeriesBook[]>([])

  useEffect(() => {
    setPlatform(novel?.targetPlatform || '默认平台')
  }, [novelId, novel?.targetPlatform])

  useEffect(() => {
    listPlatforms(novelId)
      .then((list) => {
        setPlatforms(list)
        if (list.length > 0 && !list.includes(novel?.targetPlatform || '')) setPlatform(list[0])
      })
      .catch(() => setPlatforms([]))
  }, [novelId, novel?.targetPlatform])

  const loadAnalysis = useCallback(async () => {
    if (!platform.trim()) return
    setLoading(true)
    try {
      const result = await analyzePlatform(novelId, platform, { days: 7 })
      setAnalysis(result)
      if (result.unmapped.length > 0) setUnmapped(result.unmapped)
    } catch (e) {
      setMsg({ ok: false, text: `读取平台数据失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setLoading(false)
    }
  }, [novelId, platform])

  const loadPublish = useCallback(async () => {
    try {
      const next = await getPublishOverview(novelId)
      setOverview(next)
      setPlanDrafts((prev) => {
        const merged: Record<string, string> = {}
        for (const plan of next.plans) merged[plan.chapterId] = plan.plannedDate
        return { ...merged, ...prev }
      })
    } catch (e) {
      setMsg({ ok: false, text: `读取存稿失败：${(e as Error)?.message || '未知错误'}` })
    }
  }, [novelId])

  useEffect(() => {
    void loadAnalysis()
  }, [loadAnalysis])

  useEffect(() => {
    void loadPublish()
    listLocalChapters(novelId).then(setChapters).catch(() => setChapters([]))
  }, [novelId, loadPublish])

  useEffect(() => {
    if (tab !== 'series') return
    listSeriesForNovel(novelId).then((group) => {
      setSeries(group)
      setSeriesName(group?.name ?? novel?.seriesName ?? '')
      const book = group?.books.find((b) => b.id === novelId)
      setSeriesOrder(String(book?.seriesOrder || novel?.seriesOrder || 0))
    }).catch(() => setSeries(null))
    listAllBooks().then(setAllBooks).catch(() => setAllBooks([]))
  }, [tab, novelId, novel?.seriesName, novel?.seriesOrder])

  const handlePickFile = async () => {
    try {
      const path = await window.electronAPI.dialog.openFile()
      if (!path) return
      const text = await window.electronAPI.file.read(path)
      setCsvText(text)
      setMsg({ ok: true, text: '已读取文件，确认格式后点击导入' })
    } catch (e) {
      setMsg({ ok: false, text: `读取文件失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleImport = async () => {
    if (!csvText.trim()) {
      setMsg({ ok: false, text: '先粘贴数据或选择 CSV 文件' })
      return
    }
    setImporting(true)
    setMsg(null)
    try {
      const result = importKind === 'daily'
        ? await importDailyCsv(novelId, platform, csvText)
        : importKind === 'chapter'
          ? await importChapterCsv(novelId, platform, csvText)
          : await importCommentsCsv(novelId, platform, csvText)
      setLastImport(result)
      setUnmapped(result.unmapped)
      setMsg({
        ok: result.errors.length === 0,
        text: `导入完成：新增 ${result.imported} 条，更新 ${result.updated} 条${result.errors.length ? `，${result.errors.length} 条需检查` : ''}`,
      })
      await loadAnalysis()
      await loadPublish()
    } catch (e) {
      setMsg({ ok: false, text: `导入失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setImporting(false)
    }
  }

  const handleBind = async (row: UnmappedChapter) => {
    const chapterId = bindDrafts[row.platformChapterName]
    if (!chapterId) {
      setMsg({ ok: false, text: '先选择一个本地章节' })
      return
    }
    try {
      await bindChapter(novelId, platform, row.platformChapterName, row.platformOrder, chapterId)
      setUnmapped((prev) => prev.filter((r) => r.platformChapterName !== row.platformChapterName))
      setMsg({ ok: true, text: `已把「${row.platformChapterName}」对应到本地章节` })
      await loadAnalysis()
    } catch (e) {
      setMsg({ ok: false, text: `对应失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleManualDaily = async () => {
    try {
      await saveDailyMetric(novelId, platform, {
        date: dailyDate,
        reads: Number(dailyReads) || 0,
        completionRate: Number(dailyRate) || 0,
        comments: Number(dailyComments) || 0,
        revenue: Number(dailyRevenue) || 0,
      })
      setDailyReads('')
      setDailyRate('')
      setDailyComments('')
      setDailyRevenue('')
      setMsg({ ok: true, text: `${dailyDate} 的数据已保存` })
      await loadAnalysis()
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleExportMasked = async () => {
    try {
      const csv = await buildPlatformExport(novelId, platform)
      const path = await window.electronAPI.dialog.saveFile(`${novel?.title || '作品'}-平台数据-脱敏.csv`)
      if (!path) return
      await window.electronAPI.file.write(path, csv)
      setMsg({ ok: true, text: '已导出脱敏数据：不含平台名、章节名、评论原文与精确数值' })
    } catch (e) {
      setMsg({ ok: false, text: `导出失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleClear = async () => {
    if (!window.confirm(`清空「${platform}」在本书的全部导入数据？正文不受影响。`)) return
    try {
      await clearPlatformData(novelId, platform)
      setAnalysis(null)
      setLastImport(null)
      setUnmapped([])
      setMsg({ ok: true, text: '当前平台的导入数据已清空' })
      await loadAnalysis()
    } catch (e) {
      setMsg({ ok: false, text: `清空失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleSavePlan = async (chapterId: string) => {
    const date = planDrafts[chapterId]
    if (!date) {
      setMsg({ ok: false, text: '先填写计划日期' })
      return
    }
    try {
      await savePublishPlan(novelId, chapterId, date)
      setMsg({ ok: true, text: '发布计划已保存（不会自动发布）' })
      await loadPublish()
    } catch (e) {
      setMsg({ ok: false, text: `保存计划失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleMarkPublished = async (chapterId: string) => {
    try {
      const published = await markPublished(novelId, chapterId)
      setMsg({ ok: true, text: `已记录：发布到第 ${published} 章` })
      await loadPublish()
    } catch (e) {
      setMsg({ ok: false, text: `记录失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleCopyReady = async (chapterId: string) => {
    try {
      const ready = await getReadyText(novelId, chapterId)
      await navigator.clipboard.writeText(`${ready.title}\n\n${ready.content}`)
      setMsg({ ok: true, text: '已复制标题与正文，可自行粘贴到平台（本应用不会发布）' })
    } catch (e) {
      setMsg({ ok: false, text: `复制失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleAutoPlan = async () => {
    try {
      const result = await autoPlanStock(novelId, autoStart, Number(autoPerDay) || 1)
      setMsg({
        ok: true,
        text: result.planned > 0
          ? `已为 ${result.planned} 章生成计划，最后一天 ${result.lastDate}（不会自动发布）`
          : '存稿都已排期，无需新增计划',
      })
      await loadPublish()
    } catch (e) {
      setMsg({ ok: false, text: `排期失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleSaveSeries = async () => {
    try {
      await setNovelSeries(novelId, seriesName, Number(seriesOrder) || 0)
      setMsg({ ok: true, text: seriesName.trim() ? '系列信息已保存' : '已从系列中移出' })
      setSeries(await listSeriesForNovel(novelId))
      setAllBooks(await listAllBooks())
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const jumpToChapter = async (chapterId: string) => {
    const chapter = await chapterService.getById(chapterId)
    if (chapter) selectChapter(chapter)
  }

  const trend = analysis?.trend
  const dir = directionMeta(trend?.direction ?? 'flat')
  const DirIcon = dir.icon
  const avgReads = trend && trend.points.length
    ? Math.round(trend.points.reduce((s, p) => s + p.reads, 0) / trend.points.length)
    : 0
  const avgRate = trend && trend.points.length
    ? Math.round((trend.points.reduce((s, p) => s + p.completionRate, 0) / trend.points.length) * 10) / 10
    : 0
  const totalComments = trend?.points.reduce((s, p) => s + p.comments, 0) ?? 0
  const totalRevenue = trend?.points.reduce((s, p) => s + p.revenue, 0) ?? 0
  const readsMax = Math.max(1, ...(trend?.points.map((p) => p.reads) ?? [0]))

  const planByChapter = useMemo(() => {
    const map = new Map<string, { plannedDate: string; status: string }>()
    for (const p of overview?.plans ?? []) map.set(p.chapterId, { plannedDate: p.plannedDate, status: p.status })
    return map
  }, [overview?.plans])

  return (
    <div className="h-full flex flex-col">
      {/* 平台选择 */}
      <div className="px-3 py-2 border-b border-border/20 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">平台</span>
        <input
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="w-36 px-2 py-1 text-[11px] bg-muted/20 border border-border/40 rounded focus:outline-none focus:border-primary/50"
          title="同一本书可以分别记录不同平台的数据"
        />
        {platforms.length > 1 && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) setPlatform(e.target.value) }}
            className="px-1 py-1 text-[10px] bg-muted/20 border border-border/40 rounded focus:outline-none"
            title="已导入过的平台"
          >
            <option value="">切换平台</option>
            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <button
          onClick={() => void loadAnalysis()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
          title="重新读取并分析当前平台数据"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          刷新
        </button>
      </div>

      {/* 页签 */}
      <div className="px-3 pt-2 flex items-center gap-1 border-b border-border/20">
        {TABS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1 px-2 py-1.5 text-[11px] rounded-t border-b-2 transition-colors',
                tab === t.key
                  ? 'text-primary border-primary bg-primary/5'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/20',
              )}
            >
              <Icon size={11} />
              {t.label}
            </button>
          )
        })}
      </div>

      {msg && (
        <div
          className={cn(
            'mx-3 mt-2 px-2.5 py-1.5 rounded text-[11px]',
            msg.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400',
          )}
        >
          {msg.text}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {tab === 'trend' && (
          <>
            {!analysis || analysis.dailyCount === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground/60 leading-relaxed">
                <BarChart3 size={28} className="mb-2 text-primary/40" />
                <div>还没有导入「{platform}」的数据</div>
                <div className="mt-1">到「数据导入」粘贴 7 天数据，就能看到趋势与异常章</div>
                <button
                  onClick={() => setTab('import')}
                  className="mt-3 px-3 py-1.5 text-[11px] rounded bg-primary/15 text-primary hover:bg-primary/25"
                >
                  去导入
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-2">
                  <StatCard label="日均阅读" value={formatNumber(avgReads)} />
                  <StatCard label="平均读完率" value={`${avgRate}%`} />
                  <StatCard label="近 7 天评论" value={formatNumber(totalComments)} />
                  <StatCard label="近 7 天收益" value={`¥${totalRevenue.toFixed(1)}`} />
                </div>

                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[11px] font-medium text-foreground">近 7 天阅读</span>
                    <span className={cn('flex items-center gap-0.5 text-[10px]', dir.className)}>
                      <DirIcon size={10} />
                      {dir.text} {trend && trend.readsDelta >= 0 ? '+' : ''}{trend?.readsDelta ?? 0}
                    </span>
                  </div>
                  <div className="flex items-end gap-1.5 h-24 px-1 pb-1 border-b border-border/30">
                    {(trend?.points ?? []).map((p) => {
                      const h = p.reads > 0 ? Math.max(4, Math.round((p.reads / readsMax) * 80)) : 2
                      return (
                        <div key={p.date} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`${p.date} · 阅读 ${formatNumber(p.reads)} · 读完率 ${p.completionRate}%`}>
                          <div style={{ height: `${h}px` }} className="w-full max-w-[26px] rounded-sm bg-primary/50" />
                          <span className="text-[9px] text-muted-foreground/70 truncate w-full text-center">{p.date.slice(5)}</span>
                        </div>
                      )
                    })}
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">{trend?.summary}</p>
                </section>

                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle size={12} className="text-amber-300" />
                    <span className="text-[11px] font-medium text-foreground">读完率骤降章</span>
                    <span className="text-[10px] text-muted-foreground/60">与相邻章中位数比较，只列可能原因</span>
                  </div>
                  {analysis.anomalies.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground/60">暂未发现明显骤降章（需要至少 3 章有读完率数据）。</p>
                  ) : (
                    <div className="space-y-2">
                      {analysis.anomalies.map((a) => (
                        <div key={`${a.platformChapterName}-${a.platformOrder}`} className="rounded border border-amber-500/20 bg-amber-500/5 p-2 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-foreground font-medium truncate">{a.chapterTitle}</span>
                            <span className="text-[10px] text-rose-400">↓ {a.drop} 个点</span>
                            <span className="text-[10px] text-muted-foreground">{a.completionRate}% / 相邻 {a.baseline}%</span>
                            {a.chapterId && (
                              <button
                                onClick={() => void jumpToChapter(a.chapterId!)}
                                className="ml-auto flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                              >
                                去改这一章 <ArrowRight size={10} />
                              </button>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            阅读 {formatNumber(a.reads)}{a.isHookChapter ? ' · 本章有钩子' : ''}{a.wordCount ? ` · ${formatNumber(a.wordCount)} 字` : ''}
                          </div>
                          <ul className="space-y-0.5">
                            {a.possibleCauses.map((cause) => (
                              <li key={cause} className="text-[10px] text-amber-200/80 leading-relaxed">· {cause}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare size={12} className="text-sky-300" />
                    <span className="text-[11px] font-medium text-foreground">评论情绪</span>
                    <span className="text-[10px] text-muted-foreground/60">本地词表粗判，仅供参考</span>
                  </div>
                  {analysis.sentiment.total === 0 ? (
                    <p className="text-[11px] text-muted-foreground/60">还没有导入评论内容。</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="text-emerald-400">正面 {analysis.sentiment.positive}</span>
                        <span className="text-muted-foreground">中性 {analysis.sentiment.neutral}</span>
                        <span className="text-rose-400">负向 {analysis.sentiment.negative}</span>
                        <span className="ml-auto text-muted-foreground">倾向 {analysis.sentiment.average}</span>
                      </div>
                      <div className="mt-1.5 h-1.5 rounded-full overflow-hidden flex bg-muted/30">
                        <div className="bg-emerald-400/70" style={{ width: `${(analysis.sentiment.positive / analysis.sentiment.total) * 100}%` }} />
                        <div className="bg-muted-foreground/40" style={{ width: `${(analysis.sentiment.neutral / analysis.sentiment.total) * 100}%` }} />
                        <div className="bg-rose-400/70" style={{ width: `${(analysis.sentiment.negative / analysis.sentiment.total) * 100}%` }} />
                      </div>
                      <div className="mt-2 space-y-1">
                        {analysis.sentiment.samples.slice(0, 3).map((s) => (
                          <div key={s.content} className="text-[10px] text-muted-foreground truncate">“{s.content}”</div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section>
                  <div className="text-[11px] font-medium text-foreground mb-2">挂钩章 vs 普通章</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded border border-border/30 p-2">
                      <div className="text-[10px] text-muted-foreground">挂钩章（{analysis.hookComparison.hookCount}）</div>
                      <div className="text-sm text-foreground">{analysis.hookComparison.hookAvg}%</div>
                    </div>
                    <div className="rounded border border-border/30 p-2">
                      <div className="text-[10px] text-muted-foreground">普通章（{analysis.hookComparison.normalCount}）</div>
                      <div className="text-sm text-foreground">{analysis.hookComparison.normalAvg}%</div>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">{analysis.hookComparison.note}</p>
                </section>

                {analysis.unmapped.length > 0 && (
                  <div className="rounded border border-amber-500/25 bg-amber-500/5 p-2 text-[10px] text-amber-200/90">
                    有 {analysis.unmapped.length} 个平台章节尚未对应到本地章节，到「数据导入」页签完成对应后，异常分析会更准。
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'import' && (
          <>
            <section className="space-y-2">
              <div className="flex items-center gap-1">
                {IMPORT_KINDS.map((k) => (
                  <button
                    key={k.key}
                    onClick={() => setImportKind(k.key)}
                    className={cn(
                      'px-2 py-1 text-[11px] rounded border transition-colors',
                      importKind === k.key
                        ? 'border-primary/40 bg-primary/15 text-primary'
                        : 'border-border/40 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                {IMPORT_KINDS.find((k) => k.key === importKind)?.hint}
              </p>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={IMPORT_KINDS.find((k) => k.key === importKind)?.sample}
                className="w-full h-32 px-2 py-1.5 text-[11px] font-mono bg-muted/15 border border-border/40 rounded resize-none focus:outline-none focus:border-primary/50"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handlePickFile()}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/20"
                >
                  <Upload size={11} /> 选择 CSV 文件
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={importing}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40"
                >
                  {importing ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} 导入数据
                </button>
                <button
                  onClick={() => setCsvText('')}
                  className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
                >
                  清空输入
                </button>
              </div>
              {lastImport && lastImport.errors.length > 0 && (
                <div className="rounded bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200/90 space-y-0.5">
                  {lastImport.errors.slice(0, 6).map((err) => <div key={err}>{err}</div>)}
                  {lastImport.errors.length > 6 && <div>还有 {lastImport.errors.length - 6} 条未显示</div>}
                </div>
              )}
            </section>

            {unmapped.length > 0 && (
              <section className="space-y-2">
                <div className="text-[11px] font-medium text-foreground">待对应章节（{unmapped.length}）</div>
                <p className="text-[10px] text-muted-foreground">平台章节名与本地章节不一致时，手工指定一次即可，后续导入自动沿用。</p>
                {unmapped.slice(0, 8).map((row) => (
                  <div key={row.platformChapterName} className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground truncate max-w-[140px]" title={row.platformChapterName}>
                      {row.platformOrder ? `#${row.platformOrder} ` : ''}{row.platformChapterName}
                    </span>
                    <select
                      value={bindDrafts[row.platformChapterName] ?? ''}
                      onChange={(e) => setBindDrafts((prev) => ({ ...prev, [row.platformChapterName]: e.target.value }))}
                      className="flex-1 min-w-0 px-1 py-1 text-[10px] bg-muted/20 border border-border/40 rounded focus:outline-none"
                    >
                      <option value="">选择本地章节</option>
                      {chapters.map((c) => (
                        <option key={c.chapterId} value={c.chapterId}>{`第${c.order}章 ${c.title}`}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => void handleBind(row)}
                      className="px-2 py-1 text-[10px] rounded bg-primary/15 text-primary hover:bg-primary/25"
                    >
                      对应
                    </button>
                  </div>
                ))}
              </section>
            )}

            <section className="space-y-2 border-t border-border/20 pt-3">
              <div className="text-[11px] font-medium text-foreground">手动录入一天</div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <input type="date" value={dailyDate} onChange={(e) => setDailyDate(e.target.value)}
                  className="px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <input value={dailyReads} onChange={(e) => setDailyReads(e.target.value)} placeholder="阅读"
                  className="w-16 px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <input value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} placeholder="读完率 %"
                  className="w-20 px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <input value={dailyComments} onChange={(e) => setDailyComments(e.target.value)} placeholder="评论"
                  className="w-16 px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <input value={dailyRevenue} onChange={(e) => setDailyRevenue(e.target.value)} placeholder="收益"
                  className="w-16 px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <button onClick={() => void handleManualDaily()}
                  className="px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25">
                  保存
                </button>
              </div>
            </section>

            <section className="flex items-center gap-2 border-t border-border/20 pt-3">
              <button
                onClick={() => void handleExportMasked()}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/20"
              >
                <FileDown size={11} /> 导出脱敏数据
              </button>
              <span className="text-[10px] text-muted-foreground/60">数据只存本地，导出不含平台名与精确数值</span>
              <button
                onClick={() => void handleClear()}
                className="ml-auto text-[10px] text-rose-400/80 hover:text-rose-300"
              >
                清空该平台数据
              </button>
            </section>
          </>
        )}

        {tab === 'publish' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatCard label="已发布到" value={`第 ${overview?.publishedChapter ?? 0} 章`} />
              <StatCard label="存稿" value={`${overview?.backlogChapters ?? 0} 章`} hint={`${formatNumber(overview?.backlogWords ?? 0)} 字`} />
              <StatCard label="全书章节" value={`${overview?.totalChapters ?? 0} 章`} />
            </div>

            <section className="rounded border border-border/30 p-2 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-foreground">
                <CalendarClock size={12} className="text-primary" />
                给存稿排发布计划
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>从</span>
                <input type="date" value={autoStart} onChange={(e) => setAutoStart(e.target.value)}
                  className="px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none" />
                <span>起，每天</span>
                <input value={autoPerDay} onChange={(e) => setAutoPerDay(e.target.value)}
                  className="w-12 px-1.5 py-1 bg-muted/20 border border-border/40 rounded text-center focus:outline-none" />
                <span>章</span>
                <button onClick={() => void handleAutoPlan()}
                  className="px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25">
                  一键排期
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                只生成计划与提醒，不会连接平台或自动发布；发布与数据仍需你手工确认。
              </p>
            </section>

            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <Archive size={12} className="text-sky-300" />
                <span className="text-[11px] font-medium text-foreground">存稿（已定稿、未发布）</span>
              </div>
              {(overview?.stock.length ?? 0) === 0 ? (
                <p className="text-[11px] text-muted-foreground/60">还没有存稿。章节定稿后会出现在这里。</p>
              ) : (
                overview!.stock.map((ch) => {
                  const plan = planByChapter.get(ch.chapterId)
                  return (
                    <div key={ch.chapterId} className="rounded border border-border/30 p-2 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-foreground truncate">第{ch.order}章 {ch.title}</span>
                        <span className="text-[10px] text-muted-foreground">{formatNumber(ch.wordCount)} 字</span>
                        <button
                          onClick={() => void jumpToChapter(ch.chapterId)}
                          className="ml-auto text-[10px] text-primary hover:underline"
                        >
                          打开章节
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <input
                          type="date"
                          value={planDrafts[ch.chapterId] ?? plan?.plannedDate ?? ''}
                          onChange={(e) => setPlanDrafts((prev) => ({ ...prev, [ch.chapterId]: e.target.value }))}
                          className="px-1.5 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none"
                        />
                        <button
                          onClick={() => void handleSavePlan(ch.chapterId)}
                          className="px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25"
                        >
                          保存计划
                        </button>
                        <button
                          onClick={() => void handleMarkPublished(ch.chapterId)}
                          className="px-2 py-1 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                        >
                          标记已发布
                        </button>
                        <button
                          onClick={() => void handleCopyReady(ch.chapterId)}
                          className="ml-auto flex items-center gap-0.5 px-2 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground"
                        >
                          <ClipboardCopy size={10} /> 复制正文
                        </button>
                      </div>
                      {plan && (
                        <div className={cn('text-[10px]', plan.status === 'published' ? 'text-emerald-400' : 'text-muted-foreground/70')}>
                          计划 {plan.plannedDate}{plan.status === 'published' ? ' · 已发布' : ''}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </section>

            {(overview?.upcoming.length ?? 0) > 0 && (
              <section>
                <div className="text-[11px] font-medium text-foreground mb-1.5">接下来</div>
                <div className="space-y-1">
                  {overview!.upcoming.slice(0, 5).map((ch) => (
                    <div key={ch.chapterId} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="text-foreground/80 truncate">第{ch.order}章 {ch.title}</span>
                      <span>{ch.status === 'final' ? '已定稿' : '未定稿'}</span>
                      <span className="ml-auto">{formatNumber(ch.wordCount)} 字</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {tab === 'series' && (
          <>
            <section className="space-y-2">
              <div className="text-[11px] font-medium text-foreground">把本书放进系列</div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                系列只做分组与复用参考，不合并正文，也不影响已有章节与统计。
              </p>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input
                  value={seriesName}
                  onChange={(e) => setSeriesName(e.target.value)}
                  placeholder="系列名，留空表示单本"
                  className="flex-1 px-2 py-1 bg-muted/20 border border-border/40 rounded focus:outline-none focus:border-primary/50"
                />
                <span>第</span>
                <input
                  value={seriesOrder}
                  onChange={(e) => setSeriesOrder(e.target.value)}
                  className="w-12 px-1.5 py-1 bg-muted/20 border border-border/40 rounded text-center focus:outline-none"
                />
                <span>本</span>
                <button onClick={() => void handleSaveSeries()}
                  className="px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25">
                  保存
                </button>
              </div>
            </section>

            {series && (
              <section className="rounded border border-border/30 p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <Layers size={12} className="text-indigo-300" />
                  <span className="text-[11px] text-foreground">{series.name}</span>
                  <span className="text-[10px] text-muted-foreground ml-auto">
                    {series.books.length} 本 · {formatNumber(series.chapterCount)} 章 · {formatNumber(series.wordCount)} 字
                  </span>
                </div>
                {series.books.map((b) => (
                  <div key={b.id} className="flex items-center gap-2 text-[10px]">
                    <span className="text-muted-foreground/60 w-8">{b.seriesOrder || '-'}</span>
                    <span className={cn('truncate', b.id === novelId ? 'text-primary' : 'text-foreground/80')}>{b.title}</span>
                    <span className="ml-auto text-muted-foreground">{b.chapterCount} 章 · {formatNumber(b.wordCount)} 字</span>
                  </div>
                ))}
              </section>
            )}

            <section>
              <div className="flex items-center gap-2 mb-1.5">
                <BarChart3 size={12} className="text-muted-foreground" />
                <span className="text-[11px] font-medium text-foreground">全部作品</span>
                <span className="text-[10px] text-muted-foreground">{allBooks.length} 本</span>
              </div>
              <div className="space-y-1">
                {allBooks.map((b) => (
                  <div key={b.id} className="flex items-center gap-2 text-[10px]">
                    <span className={cn('truncate', b.id === novelId ? 'text-primary font-medium' : 'text-foreground/80')}>{b.title}</span>
                    {b.seriesName && <span className="text-muted-foreground/60">[{b.seriesName}]</span>}
                    <span className="ml-auto text-muted-foreground">{b.chapterCount} 章 · {formatNumber(b.wordCount)} 字</span>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-border/30 bg-muted/10 px-2 py-1.5">
      <div className="text-[9px] text-muted-foreground">{label}</div>
      <div className="text-[12px] text-foreground font-medium">{value}</div>
      {hint && <div className="text-[9px] text-muted-foreground/60">{hint}</div>}
    </div>
  )
}