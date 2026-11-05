import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BookCheck,
  Check,
  Gauge,
  Info,
  Layers,
  Loader2,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import {
  evaluateAndSaveChapter,
  listChapterEvalRuns,
} from '@/services/chapter-eval-service'
import {
  listPreviousChapterContents,
  listReaderSimRuns,
  loadReaderProfile,
  saveReaderProfile,
  saveReaderSimRun,
  simulateReader,
} from '@/services/reader-sim-service'
import {
  addChapterFeedback,
  deleteChapterFeedback,
  FEEDBACK_VERDICT_LABEL,
  listChapterFeedback,
} from '@/services/feedback-service'
import {
  DEFAULT_READER_PROFILE,
  type ChapterEvalRun,
  type ChapterFeedbackNote,
  type EvalSeverity,
  type FeedbackVerdict,
  type ReaderProfile,
  type ReaderSimRun,
} from '@shared/review-types'
import { cn } from '@/utils/cn'

type TabKey = 'layers' | 'reader' | 'feedback'

const TABS: { key: TabKey; label: string; icon: typeof Gauge }[] = [
  { key: 'layers', label: '三层评估', icon: Layers },
  { key: 'reader', label: '读者模拟', icon: Users },
  { key: 'feedback', label: '作者反馈', icon: MessageSquareText },
]

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-400'
  if (score >= 60) return 'text-yellow-400'
  if (score >= 40) return 'text-orange-400'
  return 'text-red-400'
}

const SEVERITY_BADGE: Record<EvalSeverity, { label: string; className: string }> = {
  blocking: { label: '硬伤', className: 'bg-red-500/15 text-red-400' },
  warning: { label: '提示', className: 'bg-amber-500/15 text-amber-400' },
  advisory: { label: '建议', className: 'bg-white/5 text-muted-foreground' },
}

const LAYER_LABEL: Record<string, string> = {
  deterministic: '确定性',
  model: '模型辅助',
  human: '人工',
}

function FindingList({ run }: { run: ChapterEvalRun }) {
  const findings = [...run.deterministic.findings, ...run.model.findings]
  if (!findings.length) {
    return <p className="text-[11px] text-muted-foreground/70">没有发现明显问题。</p>
  }
  return (
    <div className="space-y-1.5">
      {findings.map((f, i) => {
        const badge = SEVERITY_BADGE[f.severity]
        return (
          <div key={`${f.ruleId}-${i}`} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className={cn('rounded px-1.5 py-0.5 text-[9px]', badge.className)}>{badge.label}</span>
              <span className="text-[11px] text-foreground">{f.label}</span>
              <span className="ml-auto text-[9px] text-muted-foreground/70">{LAYER_LABEL[f.layer]}</span>
              {f.location && <span className="text-[9px] text-muted-foreground">{f.location}</span>}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-foreground/90">{f.message}</div>
            {f.suggestion && (
              <div className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground/80">
                <Info size={10} className="mt-0.5 flex-shrink-0" />
                <span>{f.suggestion}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function LayersTab({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const content = useWorkbenchStore((s) => s.editorContent)
  const [report, setReport] = useState<ChapterEvalRun | null>(null)
  const [history, setHistory] = useState<ChapterEvalRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [useModel, setUseModel] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const loadRuns = useCallback(async () => {
    if (!selectedChapter) {
      setReport(null)
      setHistory([])
      return
    }
    const rows = await listChapterEvalRuns(selectedChapter.id, 10)
    setHistory(rows)
    setReport(rows[0] ?? null)
  }, [selectedChapter])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  const evaluate = async () => {
    if (!selectedChapter || busy) return
    if (!content.trim()) {
      setError('当前章节还没有正文。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const run = await evaluateAndSaveChapter({
        novelId,
        chapter: selectedChapter,
        content,
        useModel,
      })
      setReport(run)
      await loadRuns()
    } catch (e) {
      setError(`评估失败：${(e as Error)?.message || '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }

  if (!selectedChapter) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">未选中章节</div>
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">检测硬伤与建议，不会自动改稿</span>
        <button
          onClick={evaluate}
          disabled={busy || !content.trim()}
          className={cn(
            'ml-auto flex flex-shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : report ? <RefreshCw size={11} /> : <Gauge size={11} />}
          {busy ? '评估中…' : report ? '重新评估' : '开始评估'}
        </button>
      </div>

      <label className="mx-3 mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <input
          type="checkbox"
          checked={useModel}
          onChange={(e) => setUseModel(e.target.checked)}
          className="h-3 w-3 accent-primary"
        />
        同时做模型辅助检查（语义矛盾 / 人物声音，需要已配置模型）
      </label>

      {error && <div className="mx-3 mt-2 rounded bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">{error}</div>}

      {!report && !busy && (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center text-xs leading-relaxed text-muted-foreground/60">
          <BookCheck size={26} className="mb-3 text-muted-foreground/40" />
          还没有章节评估记录。
          <br />
          点「开始评估」先跑确定性检查，再决定是否加模型辅助。
        </div>
      )}

      {busy && !report && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">正在检查硬伤与连贯性…</span>
          </div>
        </div>
      )}

      {report && (
        <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <div className="rounded-xl border border-border/30 bg-muted/10 p-4 text-center">
            <div className="flex items-baseline justify-center gap-1">
              <span className={cn('text-4xl font-bold tabular-nums', scoreColor(report.overallScore))}>
                {report.overallScore}
              </span>
              <span className="text-sm text-muted-foreground">/ 100</span>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              确定性 {report.deterministicScore}
              {report.modelScore != null ? ` · 模型辅助 ${report.modelScore}` : ''}
              {report.styleScore != null ? ` · 文风 ${report.styleScore}` : ''}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              <span className={cn('rounded-full px-2 py-0.5 text-[10px]', report.deterministic.blocking > 0 ? 'bg-red-500/15 text-red-400' : 'bg-emerald-500/15 text-emerald-400')}>
                硬伤 {report.deterministic.blocking}
              </span>
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
                提示 {report.deterministic.warnings}
              </span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                {report.deterministic.wordCount} 字
                {report.deterministic.targetWordCount > 0 ? ` / 目标 ${report.deterministic.targetWordCount}` : ''}
              </span>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px]', report.deterministic.chapterEndHook ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/10 text-amber-400')}>
                {report.deterministic.chapterEndHook ? '章末有钩子' : '章末无钩子'}
              </span>
            </div>
            <div className="mt-1 text-[9px] text-muted-foreground/60">评估于 {formatTime(report.createdAt)}</div>
          </div>

          <div className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            {report.model.notes}
            {report.model.attempted && !report.model.available ? '（可继续使用确定性结果）' : ''}
          </div>

          <section>
            <div className="mb-1.5 flex items-center gap-1.5">
              <ShieldAlert size={11} className="text-muted-foreground" />
              <span className="text-[11px] font-medium text-muted-foreground">
                发现（{report.deterministic.findings.length + report.model.findings.length}）
              </span>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
              >
                {expanded ? '收起' : '展开'}
              </button>
            </div>
            {expanded && <FindingList run={report} />}
          </section>

          {!!report.suggestions.length && (
            <section>
              <div className="mb-1.5 flex items-center gap-1.5">
                <Sparkles size={11} className="text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">可执行建议</span>
              </div>
              <div className="space-y-1">
                {report.suggestions.map((s, i) => (
                  <div key={i} className="flex items-start gap-1 rounded bg-muted/10 px-2 py-1 text-[10px] leading-relaxed text-foreground/80">
                    <span className="mt-0.5 text-muted-foreground">{i + 1}.</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {history.length > 1 && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">历史评估</h4>
              <div className="space-y-1">
                {history.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setReport(r)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] transition-colors',
                      r.id === report.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/20',
                    )}
                  >
                    <span className="tabular-nums">{formatTime(r.createdAt)}</span>
                    <span className="ml-auto tabular-nums">综合 {r.overallScore}</span>
                    <span className="tabular-nums text-muted-foreground/70">确定性 {r.deterministicScore}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  )
}

const GENDER_OPTIONS: { value: ReaderProfile['genderOrientation']; label: string }[] = [
  { value: 'unspecified', label: '未指定' },
  { value: 'male', label: '男性向' },
  { value: 'female', label: '女性向' },
  { value: 'general', label: '大众向' },
]

const PAYOFF_BADGE: Record<string, { label: string; className: string }> = {
  paid: { label: '已兑现', className: 'bg-emerald-500/15 text-emerald-400' },
  partial: { label: '部分兑现', className: 'bg-amber-500/15 text-amber-400' },
  unpaid: { label: '未兑现', className: 'bg-red-500/15 text-red-400' },
}

function ReaderTab({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const content = useWorkbenchStore((s) => s.editorContent)
  const [profile, setProfile] = useState<ReaderProfile>({ ...DEFAULT_READER_PROFILE })
  const [scope, setScope] = useState<'chapter' | 'first3'>('chapter')
  const [useModel, setUseModel] = useState(true)
  const [result, setResult] = useState<ReaderSimRun | null>(null)
  const [history, setHistory] = useState<ReaderSimRun[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const p = await loadReaderProfile(novelId)
      if (alive) setProfile(p)
    })()
    return () => {
      alive = false
    }
  }, [novelId])

  const chapterId = selectedChapter?.id ?? null

  useEffect(() => {
    let alive = true
    void (async () => {
      const rows = await listReaderSimRuns(novelId, 30)
      if (!alive) return
      const own = chapterId ? rows.filter((r) => r.chapterIds.includes(chapterId)) : []
      setHistory(own.slice(0, 10))
      setResult(own[0] ?? null)
    })()
    return () => {
      alive = false
    }
  }, [novelId, chapterId])

  const run = async () => {
    if (!selectedChapter || busy) return
    if (!content.trim()) {
      setError('当前章节还没有正文。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await saveReaderProfile(novelId, profile)
      const previous = scope === 'first3'
        ? await listPreviousChapterContents(novelId, selectedChapter.id, 2)
        : []
      const sim = await simulateReader({
        novelId,
        chapter: selectedChapter,
        content,
        previous,
        profile,
        useModel,
      })
      const saved = await saveReaderSimRun({
        novelId,
        chapterIds: [...previous.map((p) => p.id), selectedChapter.id],
        profile,
        result: sim,
      })
      setResult(saved)
      setHistory((prev) => [saved, ...prev].slice(0, 10))
    } catch (e) {
      setError(`模拟失败：${(e as Error)?.message || '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }

  if (!selectedChapter) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">未选中章节</div>
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">按目标读者视角找弃读点，不预测成败</span>
        <button
          onClick={run}
          disabled={busy || !content.trim()}
          className={cn(
            'ml-auto flex flex-shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
            'bg-primary/15 text-primary hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Users size={11} />}
          {busy ? '模拟中…' : '开始模拟'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <section className="rounded-lg border border-border/20 bg-muted/10 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Users size={11} className="text-muted-foreground" />
            <span className="text-[11px] font-medium text-muted-foreground">目标读者画像</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="text-[10px] text-muted-foreground">
              题材
              <input
                value={profile.genre}
                onChange={(e) => setProfile((p) => ({ ...p, genre: e.target.value }))}
                placeholder="例如：都市异能"
                className="mt-0.5 w-full rounded border border-border/30 bg-background/40 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
              />
            </label>
            <label className="text-[10px] text-muted-foreground">
              平台
              <input
                value={profile.platform}
                onChange={(e) => setProfile((p) => ({ ...p, platform: e.target.value }))}
                placeholder="例如：番茄 / 起点"
                className="mt-0.5 w-full rounded border border-border/30 bg-background/40 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
              />
            </label>
          </div>
          <label className="mt-1.5 block text-[10px] text-muted-foreground">
            性别向
            <select
              value={profile.genderOrientation}
              onChange={(e) => setProfile((p) => ({ ...p, genderOrientation: e.target.value as ReaderProfile['genderOrientation'] }))}
              className="mt-0.5 w-full rounded border border-border/30 bg-background/40 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
            >
              {GENDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="mt-1.5 block text-[10px] text-muted-foreground">
            补充说明
            <input
              value={profile.note}
              onChange={(e) => setProfile((p) => ({ ...p, note: e.target.value }))}
              placeholder="例如：喜欢快节奏、强冲突"
              className="mt-0.5 w-full rounded border border-border/30 bg-background/40 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
            />
          </label>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={scope === 'chapter'}
                onChange={() => setScope('chapter')}
                className="h-3 w-3 accent-primary"
              />
              单章
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={scope === 'first3'}
                onChange={() => setScope('first3')}
                className="h-3 w-3 accent-primary"
              />
              含前 2 章
            </label>
            <label className="ml-auto flex items-center gap-1">
              <input
                type="checkbox"
                checked={useModel}
                onChange={(e) => setUseModel(e.target.checked)}
                className="h-3 w-3 accent-primary"
              />
              结合模型
            </label>
          </div>
        </section>

        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-400">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          <span>以下是模拟判断，不是真实读者数据；不替代作者判断，也不会自动改稿。</span>
        </div>

        {error && <div className="mt-2 rounded bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">{error}</div>}

        {!result && !busy && (
          <div className="mt-8 text-center text-xs leading-relaxed text-muted-foreground/60">
            <Users size={24} className="mx-auto mb-2 text-muted-foreground/40" />
            还没有模拟记录。
            <br />
            填好读者画像后点「开始模拟」。
          </div>
        )}

        {result && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Gauge size={10} /> 钩子强度
                </div>
                <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', scoreColor(result.hookStrength))}>
                  {result.hookStrength}
                  <span className="text-[10px] font-normal text-muted-foreground"> / 100</span>
                </div>
              </div>
              <div className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Activity size={10} /> 信息密度
                </div>
                <div className={cn('mt-0.5 text-lg font-semibold tabular-nums', scoreColor(result.infoDensity))}>
                  {result.infoDensity}
                  <span className="text-[10px] font-normal text-muted-foreground"> / 100</span>
                </div>
              </div>
            </div>

            <section>
              <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">情绪曲线（五段）</h4>
              <div className="flex h-16 items-end gap-1 rounded-lg border border-border/20 bg-muted/10 px-2 py-1.5">
                {result.emotionCurve.map((v, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex h-10 w-full items-end">
                      <div
                        className={cn('w-full rounded-sm', v >= 60 ? 'bg-emerald-400/70' : v >= 30 ? 'bg-yellow-400/70' : 'bg-red-400/60')}
                        style={{ height: `${Math.max(4, v)}%` }}
                      />
                    </div>
                    <span className="text-[8px] tabular-nums text-muted-foreground/70">{v}</span>
                  </div>
                ))}
              </div>
            </section>

            {!!result.questions.length && (
              <section>
                <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">读者可能带走的问题</h4>
                <div className="space-y-1">
                  {result.questions.map((q, i) => (
                    <div key={i} className="rounded bg-muted/10 px-2 py-1 text-[10px] text-foreground/80">{q}</div>
                  ))}
                </div>
              </section>
            )}

            {!!result.payoffs.length && (
              <section>
                <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">期待兑现点</h4>
                <div className="space-y-1">
                  {result.payoffs.map((p, i) => {
                    const badge = PAYOFF_BADGE[p.status]
                    return (
                      <div key={i} className="rounded-lg border border-border/20 bg-muted/10 px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('rounded px-1.5 py-0.5 text-[9px]', badge.className)}>{badge.label}</span>
                          <span className="text-[10px] text-foreground">{p.expectation}</span>
                        </div>
                        {p.note && <div className="mt-0.5 text-[9px] text-muted-foreground/80">{p.note}</div>}
                      </div>
                    )
                  })}
                </div>
              </section>
            )}

            {!!result.dropOffs.length && (
              <section>
                <h4 className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                  <AlertTriangle size={10} /> 可能的弃读点
                </h4>
                <div className="space-y-1">
                  {result.dropOffs.map((d, i) => (
                    <div key={i} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
                      <div className="text-[10px] font-medium text-amber-400">{d.location} · {d.reason}</div>
                      <div className="mt-0.5 text-[10px] text-foreground/80">{d.suggestion}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h4 className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Sparkles size={10} /> 可执行建议（{result.suggestions.length}）
              </h4>
              <div className="space-y-1">
                {result.suggestions.map((s, i) => (
                  <div key={i} className="flex items-start gap-1 rounded bg-muted/10 px-2 py-1 text-[10px] leading-relaxed text-foreground/80">
                    <span className="mt-0.5 text-muted-foreground">{i + 1}.</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </section>

            <div className="text-[9px] text-muted-foreground/60">
              {result.modelAssisted ? '规则 + 模型模拟' : '规则模拟（未使用模型）'} · 覆盖 {result.chapterCount} 章 · {formatTime(result.createdAt)}
            </div>

            {history.length > 1 && (
              <section>
                <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">历史模拟</h4>
                <div className="space-y-1">
                  {history.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setResult(r)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] transition-colors',
                        r.id === result.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/20',
                      )}
                    >
                      <span className="tabular-nums">{formatTime(r.createdAt)}</span>
                      <span className="text-muted-foreground/70">{r.chapterCount} 章</span>
                      <span className="ml-auto tabular-nums">钩子 {r.hookStrength}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  )
}

const VERDICT_BADGE: Record<FeedbackVerdict, string> = {
  accepted: 'bg-emerald-500/15 text-emerald-400',
  rejected: 'bg-amber-500/15 text-amber-400',
  note: 'bg-white/5 text-muted-foreground',
}

function FeedbackTab({ novelId }: { novelId: string }) {
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const [notes, setNotes] = useState<ChapterFeedbackNote[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selectedChapter) {
      setNotes([])
      return
    }
    setNotes(await listChapterFeedback(selectedChapter.id, 30))
  }, [selectedChapter])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async (verdict: FeedbackVerdict) => {
    if (!selectedChapter || busy) return
    if (verdict === 'note' && !comment.trim()) {
      setError('先写一条批注再保存。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await addChapterFeedback({
        novelId,
        chapterId: selectedChapter.id,
        verdict,
        comment,
      })
      setComment('')
      await load()
    } catch (e) {
      setError(`保存失败：${(e as Error)?.message || '未知错误'}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    await deleteChapterFeedback(id)
    await load()
  }

  if (!selectedChapter) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/60">未选中章节</div>
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/20 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">你的判断优先于任何自动评估</span>
        <ShieldCheck size={12} className="ml-auto text-muted-foreground/60" />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="rounded-lg border border-border/20 bg-muted/10 p-2.5">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="记一条修改意见，或说明接受/拒绝的原因…"
            className="w-full resize-none rounded border border-border/30 bg-background/40 px-2 py-1.5 text-[11px] leading-relaxed text-foreground outline-none focus:border-primary/50"
          />
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              onClick={() => submit('accepted')}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-400 transition-colors hover:bg-emerald-500/25 disabled:opacity-40"
            >
              <Check size={10} /> 接受这版
            </button>
            <button
              onClick={() => submit('rejected')}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-[10px] text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-40"
            >
              <X size={10} /> 需要修改
            </button>
            <button
              onClick={() => submit('note')}
              disabled={busy}
              className="ml-auto flex items-center gap-1 rounded bg-primary/15 px-2 py-1 text-[10px] text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : <MessageSquareText size={10} />}
              记一条批注
            </button>
          </div>
        </div>

        {error && <div className="mt-2 rounded bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">{error}</div>}

        <div className="mt-3 space-y-1.5">
          {notes.length === 0 && (
            <div className="mt-6 text-center text-xs leading-relaxed text-muted-foreground/60">
              还没有作者反馈。
              <br />
              接受、拒绝或批注都会留在这里。
            </div>
          )}
          {notes.map((n) => (
            <div key={n.id} className="rounded-lg border border-border/20 bg-muted/10 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className={cn('rounded px-1.5 py-0.5 text-[9px]', VERDICT_BADGE[n.verdict])}>
                  {FEEDBACK_VERDICT_LABEL[n.verdict]}
                </span>
                <span className="text-[9px] text-muted-foreground/70">{formatTime(n.createdAt)}</span>
                <button
                  onClick={() => void remove(n.id)}
                  className="ml-auto rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-red-400"
                  aria-label="删除这条反馈"
                >
                  <Trash2 size={10} />
                </button>
              </div>
              {n.comment && <div className="mt-1 text-[10px] leading-relaxed text-foreground/85">{n.comment}</div>}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

export default function ChapterReviewPanel({ novelId }: { novelId: string }) {
  const [tab, setTab] = useState<TabKey>('layers')

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border/20 px-2 py-1.5">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors',
              tab === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted/30',
            )}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'layers' && <LayersTab novelId={novelId} />}
      {tab === 'reader' && <ReaderTab novelId={novelId} />}
      {tab === 'feedback' && <FeedbackTab novelId={novelId} />}
    </>
  )
}
