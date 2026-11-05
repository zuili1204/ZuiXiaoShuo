import { useState, useEffect, useCallback } from 'react'
import { History, X, Camera, RotateCcw, FileText, ChevronLeft, ShieldCheck, ShieldAlert, Gauge, AlertTriangle, Info, Loader2, Wand2, ListTree, ClipboardList, Layers, Sparkles, BookCheck, GitCompare } from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import {
  createSnapshot,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  snapshotSourceLabel,
  type SnapshotMeta,
} from '@/services/snapshot-service'
import { indexChapterContent } from '@/services/rag-service'
import SceneCardPanel from './SceneCardPanel'
import StateCardPanel from './StateCardPanel'
import ContextPreviewPanel from './ContextPreviewPanel'
import ContinuityPanel from './ContinuityPanel'
import StyleEvalPanel from './StyleEvalPanel'
import ChapterReviewPanel from './ChapterReviewPanel'
import RevisionPanel from './RevisionPanel'
import { cn } from '@/utils/cn'

// 编辑器工具抽屉：历史版本 / AI 率检测共用容器（同一面板内切换内容，不叠加弹层）
// 壳层仿 SearchPanel：右侧滑入 420px 面板 + 左侧半透明遮罩
export default function EditorToolDrawer({ novelId }: { novelId: string }) {
  const drawer = useWorkbenchStore((s) => s.editorDrawer)
  const setEditorDrawer = useWorkbenchStore((s) => s.setEditorDrawer)

  if (!drawer) return null

  const DRAWER_META = {
    snapshots: { title: '历史版本', icon: History },
    'ai-rate': { title: 'AI 率检测', icon: ShieldCheck },
    scenes: { title: '场景卡', icon: ListTree },
    state: { title: '状态卡', icon: ClipboardList },
    context: { title: '上下文预览', icon: Layers },
    continuity: { title: '连贯性检查', icon: ShieldAlert },
    'style-eval': { title: '文风评估', icon: Sparkles },
    review: { title: '章节评估', icon: BookCheck },
    revision: { title: '改稿与级联', icon: GitCompare },
  } as const
  const { title, icon: HeaderIcon } = DRAWER_META[drawer]

  return (
    <div className="absolute inset-0 z-40 flex">
      <div className="flex-1 bg-black/40" onClick={() => setEditorDrawer(null)} />
      <div className="w-[420px] h-full bg-card border-l border-border/40 shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/30">
          <HeaderIcon size={14} className="text-muted-foreground" />
          <span className="text-sm text-foreground font-medium">{title}</span>
          <button
            onClick={() => setEditorDrawer(null)}
            aria-label="关闭抽屉"
            className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {drawer === 'snapshots' && <SnapshotsView novelId={novelId} />}
        {drawer === 'ai-rate' && <AiRateView />}
        {drawer === 'scenes' && <SceneCardPanel novelId={novelId} />}
        {drawer === 'state' && <StateCardPanel novelId={novelId} />}
        {drawer === 'context' && <ContextPreviewPanel novelId={novelId} />}
        {drawer === 'continuity' && <ContinuityPanel novelId={novelId} />}
        {drawer === 'style-eval' && <StyleEvalPanel novelId={novelId} />}
        {drawer === 'review' && <ChapterReviewPanel novelId={novelId} />}
        {drawer === 'revision' && <RevisionPanel novelId={novelId} />}
      </div>
    </div>
  )
}

// ===== 历史版本视图 =====

const SOURCE_BADGE: Record<string, string> = {
  auto: 'bg-muted/40 text-muted-foreground',
  manual: 'bg-primary/15 text-primary',
  finish: 'bg-green-500/15 text-green-400',
  pipeline: 'bg-purple-500/15 text-purple-400',
  'pre-restore': 'bg-amber-500/15 text-amber-400',
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function SnapshotsView({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const reloadEditor = useWorkbenchStore((s) => s.reloadEditor)

  const [metas, setMetas] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const flashMsg = useCallback((text: string) => {
    setMsg(text)
    window.setTimeout(() => setMsg(null), 3000)
  }, [])

  const refresh = useCallback(async () => {
    if (!selectedChapter) {
      setMetas([])
      return
    }
    setLoading(true)
    try {
      setMetas(await listSnapshots(selectedChapter.id))
    } catch (e) {
      console.error('Failed to list snapshots:', e)
      setMetas([])
    } finally {
      setLoading(false)
    }
  }, [selectedChapter])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 恢复的二步确认：3 秒内再点一次才执行，超时自动复位
  useEffect(() => {
    if (!confirmName) return
    const timer = window.setTimeout(() => setConfirmName(null), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmName])

  const handleManualSnapshot = async () => {
    if (!selectedChapter) return
    try {
      const created = await createSnapshot(selectedChapter.id, 'manual', { force: true })
      flashMsg(created ? '已保存当前版本' : '当前章节内容为空，无需快照')
      await refresh()
    } catch (e) {
      flashMsg(`快照失败：${(e as Error).message}`)
    }
  }

  const handleRestore = async (name: string) => {
    if (!selectedChapter) return
    // 二步确认：第一次点击进入确认态
    if (confirmName !== name) {
      setConfirmName(name)
      return
    }
    setConfirmName(null)
    try {
      const text = await restoreSnapshot(selectedChapter.id, name)
      // 恢复后刷新编辑器并重建本章 RAG 索引，保证 AI 上下文同步
      indexChapterContent(novelId, selectedChapter.id, selectedChapter.title, text, selectedChapter.order)
      reloadEditor()
      flashMsg('已恢复该版本（恢复前的内容已另存快照）')
      await refresh()
    } catch (e) {
      flashMsg(`恢复失败：${(e as Error).message}`)
    }
  }

  const handlePreview = async (name: string) => {
    if (!selectedChapter) return
    try {
      const content = await readSnapshot(selectedChapter.id, name)
      setPreview({ name, content })
    } catch (e) {
      flashMsg(`读取失败：${(e as Error).message}`)
    }
  }

  // ===== 预览态 =====
  if (preview) {
    return (
      <>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/20 text-[11px] text-muted-foreground">
          <button
            onClick={() => setPreview(null)}
            className="flex items-center gap-0.5 hover:text-foreground transition-colors"
          >
            <ChevronLeft size={12} />
            返回列表
          </button>
          <span className="ml-auto">{formatTime(parseTs(preview.name))}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">{preview.content}</div>
        </div>
      </>
    )
  }

  // ===== 列表态 =====
  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center">
        <span className="text-[11px] text-muted-foreground">
          {selectedChapter ? `《${selectedChapter.title}》的留底版本，最多保留 50 份` : '未选中章节'}
        </span>
        <button
          onClick={handleManualSnapshot}
          disabled={!selectedChapter}
          className={cn(
            'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          <Camera size={11} />
          手动快照
        </button>
      </div>

      {msg && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-muted/30 text-[11px] text-foreground">{msg}</div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && <div className="text-center text-xs text-muted-foreground py-8">加载中…</div>}
        {!loading && metas.length === 0 && (
          <div className="text-center text-xs text-muted-foreground/60 py-10 leading-relaxed px-6">
            还没有历史版本。
            <br />
            编辑内容自动保存后会自动留底，也可以点上方「手动快照」随时留个存档。
          </div>
        )}
        {metas.map((meta) => (
          <div
            key={meta.name}
            className={cn(
              'group w-full px-2.5 py-2 rounded-lg mb-1 border border-transparent',
              'hover:bg-muted/30 hover:border-border/30 transition-colors'
            )}
          >
            <div className="flex items-center gap-1.5">
              <FileText size={11} className="text-muted-foreground flex-shrink-0" />
              <span className="text-[12px] text-foreground font-medium">{formatTime(meta.ts)}</span>
              <span
                className={cn(
                  'text-[9px] px-1.5 py-0.5 rounded flex-shrink-0',
                  SOURCE_BADGE[meta.source] ?? 'bg-muted/40 text-muted-foreground'
                )}
              >
                {snapshotSourceLabel(meta.source)}
              </span>
              <div className="ml-auto flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handlePreview(meta.name)}
                  className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  预览
                </button>
                <button
                  onClick={() => handleRestore(meta.name)}
                  className={cn(
                    'flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors',
                    confirmName === meta.name
                      ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                  )}
                >
                  <RotateCcw size={10} />
                  {confirmName === meta.name ? '确认恢复？' : '恢复'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// 从快照文件名取时间戳（预览态标题用）；解析失败退回当前时间
function parseTs(name: string): number {
  const m = /^(\d{8})-(\d{6})/.exec(name)
  if (!m) return Date.now()
  const [, ymd, hms] = m
  const ts = Date.parse(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` +
    `T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`
  )
  return Number.isNaN(ts) ? Date.now() : ts
}

// ===== AI 率检测视图 =====

// AI 味指数 = 100 − score：越低越像人写的
function rateLevel(rate: number): { text: string; color: string; ring: string; hint: string } {
  if (rate <= 15) {
    return { text: '很像人写的', color: 'text-emerald-400', ring: 'text-emerald-400', hint: 'AI 味很低，保持这个手感' }
  }
  if (rate <= 40) {
    return { text: '基本自然', color: 'text-yellow-400', ring: 'text-yellow-400', hint: '有少量 AI 痕迹，可选择性润色' }
  }
  if (rate <= 70) {
    return { text: 'AI 味偏重', color: 'text-orange-400', ring: 'text-orange-400', hint: '建议处理高亮问题后再发布' }
  }
  return { text: 'AI 味很重', color: 'text-red-400', ring: 'text-red-400', hint: '命中较多 AI 句式，建议先去 AI 味' }
}

const SEVERITY_BADGE: Record<string, string> = {
  blocking: 'bg-red-500/15 text-red-400',
  advisory: 'bg-amber-500/15 text-amber-400',
}

const SOURCE_LABEL: Record<string, string> = {
  'ai-patterns': 'AI 句式',
  degeneration: '退化',
  'style-metrics': '文风',
}

function AiRateView() {
  const editorContent = useWorkbenchStore((s) => s.editorContent)
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const aiReportGate = useWorkbenchStore((s) => s.aiReportGate)
  const aiReportChapterId = useWorkbenchStore((s) => s.aiReportChapterId)
  const checking = useWorkbenchStore((s) => s.aiReportChecking)
  const err = useWorkbenchStore((s) => s.aiReportError)
  const runAiReportCheck = useWorkbenchStore((s) => s.runAiReportCheck)
  const setPendingSkillInject = useWorkbenchStore((s) => s.setPendingSkillInject)
  const toggleRightCollapsed = useWorkbenchStore((s) => s.toggleRightCollapsed)

  // 双保险：即便外部直接改了 selectedChapter，也不展示上一章的报告
  const gate = aiReportChapterId === (selectedChapter?.id ?? null) ? aiReportGate : null
  const detect = () => {
    void runAiReportCheck()
  }

  const handleDeslop = () => {
    setPendingSkillInject('请使用「story-deslop」技能处理当前章节。')
    toggleRightCollapsed()
  }

  // 空态：还没检测过
  if (!gate && !checking) {
    return (
      <>
        <div className="px-3 py-2 border-b border-border/20 flex items-center">
          <span className="text-[11px] text-muted-foreground">手动检测当前章节的 AI 味，不会自动运行</span>
          <button
            onClick={detect}
            disabled={checking || !editorContent.trim()}
            className={cn(
              'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors',
              'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            <Gauge size={11} />
            开始检测
          </button>
        </div>
        {err && (
          <div className="mx-3 mt-2 px-2.5 py-1.5 rounded bg-red-500/10 text-[11px] text-red-400">{err}</div>
        )}
        <div className="flex-1 overflow-y-auto px-6 py-10 text-center text-xs text-muted-foreground/60 leading-relaxed">
          <ShieldCheck size={28} className="mx-auto mb-3 text-muted-foreground/40" />
          点上方「开始检测」跑一次 AI 味分析。
          <br />
          检测只在本机运行，不会上传任何内容。
        </div>
      </>
    )
  }

  // 首次检测进行中（尚无历史结果）：只渲染检测中占位
  if (!gate) {
    return (
      <>
        <div className="px-3 py-2 border-b border-border/20 flex items-center">
          <span className="text-[11px] text-muted-foreground">检测中</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">正在逐行扫描 AI 句式与退化痕迹…</span>
          </div>
        </div>
      </>
    )
  }

  const rate = 100 - gate.score
  const level = rateLevel(rate)
  const findings = gate.findings ?? []
  const degraded = gate.findings === undefined

  return (
    <>
      <div className="px-3 py-2 border-b border-border/20 flex items-center">
        <span className="text-[11px] text-muted-foreground">
          {selectedChapter ? `《${selectedChapter.title}》` : ''}
          {gate.checkedAt ? ` · 检测于 ${new Date(gate.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <button
          onClick={detect}
          disabled={checking || !editorContent.trim()}
          className={cn(
            'ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 disabled:cursor-not-allowed'
          )}
        >
          {checking ? <Loader2 size={11} className="animate-spin" /> : <Gauge size={11} />}
          {checking ? '检测中…' : '重新检测'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* 指数大卡 */}
        <div className="rounded-xl border border-border/30 bg-muted/10 p-4 text-center">
          {checking ? (
            <div className="py-4 flex flex-col items-center gap-2">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">正在逐行扫描 AI 句式与退化痕迹…</span>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-center gap-1">
                <span className={cn('text-4xl font-bold tabular-nums', level.color)}>{rate}</span>
                <span className="text-sm text-muted-foreground">/ 100</span>
              </div>
              <div className={cn('mt-1 text-[12px] font-medium', level.color)}>{level.text} · AI 味指数</div>
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">{level.hint}</p>
              <div className="mt-3 flex items-center justify-center gap-1.5">
                <span className={cn('rounded-full px-2 py-0.5 text-[10px]', gate.deslopTag ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400')}>
                  {gate.deslopTag ? '已过去 AI 味' : 'AI 味风险'}
                </span>
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                  AI 句式 {gate.aiPatternHits}
                </span>
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                  退化 {gate.degenerationHits}
                </span>
                {degraded && (
                  <span
                    className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400"
                    title="确定性脚本不可用，本次为启发式评分"
                  >
                    启发式降级
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {err && (
          <div className="mt-2 px-2.5 py-1.5 rounded bg-red-500/10 text-[11px] text-red-400">{err}</div>
        )}

        {/* 行级发现列表 */}
        {findings.length > 0 && (
          <>
            <div className="mt-4 mb-2 flex items-center gap-1.5">
              <AlertTriangle size={11} className="text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">具体问题（{findings.length} 处）</span>
            </div>
            <div className="space-y-1.5">
              {findings.map((f, i) => (
                <div key={i} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground tabular-nums">第{f.line}行</span>
                    <span className={cn('text-[9px] px-1.5 py-0.5 rounded', SEVERITY_BADGE[f.severity] ?? 'bg-muted/40 text-muted-foreground')}>
                      {f.severity === 'blocking' ? '硬伤' : '提示'}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-muted-foreground">
                      {SOURCE_LABEL[f.source] ?? f.source}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-foreground/90 leading-relaxed">{f.message}</div>
                  {f.excerpt && (
                    <div className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground/80">
                      <Info size={10} className="mt-0.5 flex-shrink-0" />
                      <span className="whitespace-pre-wrap">{f.excerpt}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* 启发式降级（无行级 findings）时展示报告文本 */}
        {!checking && findings.length === 0 && gate.report && (
          <div className="mt-3 rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2 text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
            {gate.report}
          </div>
        )}

        {/* 去 AI 味闭环 */}
        {!checking && (
          <button
            onClick={handleDeslop}
            className={cn(
              'mt-4 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors',
              'bg-purple-500/15 text-purple-300 hover:bg-purple-500/25'
            )}
          >
            <Wand2 size={12} />
            一键送去 AI 味润色
          </button>
        )}
      </div>
    </>
  )
}
