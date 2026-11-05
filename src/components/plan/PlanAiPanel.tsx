import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import type {
  ChapterDetailProposal,
  ChapterSkeleton,
  Character,
  ConfirmedSeed,
  MasterPlan,
  Novel,
  OutlineReview,
  OutlineReviewIssue,
  OutlineSeedProposal,
  ProposedCharacter,
  RecalibrateDiff,
} from '@shared/types'
import type { VolChap } from '@/services/ai-outline'
import { getAgent } from '@/services/ai-outline'
import {
  applyCalibration,
  applyChapterDetail,
  applyProspectiveOutline,
  applyReviewPatches,
  applySeedProposal,
  applyVolumeChapters,
  calibrateOutline,
  draftChapterDetail,
  draftMasterPlan,
  draftOutlineSeed,
  draftVolumeChapters,
  reviewOutline,
  type PlannerProgress,
} from '@/services/outline-planner'
import { novelService } from '@/services/data-service'
import { knowledgeService } from '@/services/knowledge-service'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { PLAN_MODES, roleLabel, seedCharactersText, seedFormFrom, seedOutlineFrom, type PlanMode, type PlanSelection, type SeedForm } from './plan-utils'

interface Props {
  novelId: string
  novel: Novel
  vols: VolChap[]
  characters: Character[]
  seedForm: SeedForm
  onSeedFormChange: (patch: Partial<SeedForm>) => void
  selection: PlanSelection
  mode: PlanMode
  onModeChange: (mode: PlanMode) => void
  onApplied: () => Promise<void>
  /** 采纳前落盘编辑区待保存内容，避免旧值随后覆盖提案 */
  onBeforeAdopt: () => Promise<void>
  onSelect: (selection: PlanSelection) => void
  onToast: (message: string, kind?: 'ok' | 'error') => void
}

type SeedDraft = {
  title: string
  genre: string
  premise: string
  characters: ProposedCharacter[]
}

type Proposal =
  | { kind: 'seed'; data: OutlineSeedProposal; draft: SeedDraft }
  | { kind: 'master'; data: MasterPlan; draft: MasterPlan }
  | {
      kind: 'volume-chapters'
      data: ChapterSkeleton[]
      draft: ChapterSkeleton[]
      volumeId: string
      volumeTitle: string
    }
  | {
      kind: 'chapter-detail'
      data: ChapterDetailProposal
      draft: ChapterDetailProposal
      chapterId: string
      chapterTitle: string
    }
  | { kind: 'review'; data: OutlineReview; selected: Record<string, boolean> }
  | {
      kind: 'calibrate'
      data: RecalibrateDiff
      selected: Record<string, boolean>
      hooks: Record<string, string[]>
    }

interface HistoryItem {
  id: string
  at: string
  label: string
  detail: string
  applied: boolean
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const inputCls =
  'h-8 w-full rounded-md bg-muted/25 border border-border/50 px-2.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20'
const textareaCls =
  'w-full rounded-md bg-muted/25 border border-border/50 px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none leading-relaxed'
const labelCls = 'mb-1 block text-[10px] text-muted-foreground'

const SEVERITY_LABEL: Record<string, string> = {
  blocking: '阻断',
  warning: '警告',
  info: '提示',
}

const SEVERITY_CLASS: Record<string, string> = {
  blocking: 'border-red-500/30 bg-red-500/10 text-red-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  info: 'border-sky-500/25 bg-sky-500/10 text-sky-300',
}

function modeLabel(mode: PlanMode | Proposal['kind']): string {
  return PLAN_MODES.find((m) => m.id === mode)?.label ?? mode
}

export default function PlanAiPanel({
  novelId,
  novel,
  vols,
  characters,
  seedForm,
  onSeedFormChange,
  selection,
  mode,
  onModeChange,
  onApplied,
  onBeforeAdopt,
  onSelect,
  onToast,
}: Props) {
  const navigate = useNavigate()
  const [notes, setNotes] = useState('')
  const [running, setRunning] = useState(false)
  const [finished, setFinished] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [applying, setApplying] = useState(false)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [agentReady, setAgentReady] = useState<boolean | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    getAgent()
      .then((a) => {
        if (!cancelled) setAgentReady(!!a)
      })
      .catch(() => {
        if (!cancelled) setAgentReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const targetVolume = useMemo(() => {
    if (selection.kind === 'volume') {
      return vols.find((v) => v.vol.id === selection.volumeId) ?? vols[0] ?? null
    }
    if (selection.kind === 'chapter') {
      return vols.find((v) => v.vol.id === selection.volumeId) ?? null
    }
    return vols[0] ?? null
  }, [selection, vols])

  const targetChapter = useMemo(() => {
    for (const v of vols) {
      const chapter = v.chapters.find((c) => c.id === (selection.kind === 'chapter' ? selection.chapterId : ''))
      if (chapter) return { chapter, volume: v.vol }
    }
    const first = vols[0]?.chapters[0]
    return first && vols[0] ? { chapter: first, volume: vols[0].vol } : null
  }, [selection, vols])

  const autoCharacterText = useMemo(
    () => seedCharactersText(seedFormFrom(novel, characters)),
    [novel, characters],
  )

  const confirmedSeed = (): ConfirmedSeed => ({
    title: seedForm.title.trim() || novel.title,
    genre: seedForm.genre.trim() || novel.genre[0] || '',
    premise: seedForm.premise.trim() || novel.description,
    characters: characters.map((c) => ({
      name: c.name,
      role:
        c.role === 'functional'
          ? 'supporting'
          : (c.role as ProposedCharacter['role']),
      profile: c.profile,
    })),
    volumeCount: +seedForm.volCount || vols.length || 0,
    chapterCount: +seedForm.chCount || undefined,
    characterNotes:
      seedCharactersText(seedForm) && seedCharactersText(seedForm) !== autoCharacterText.trim()
        ? seedCharactersText(seedForm)
        : undefined,
    coreConflict: seedForm.coreConflict.trim() || undefined,
    protagonist: seedForm.protagonist.trim() || undefined,
    worldview: seedForm.worldview.trim() || undefined,
    setting: seedForm.setting.trim() || undefined,
    power: seedForm.power.trim() || undefined,
    sellingPoints: seedForm.sellingPoints.trim() || undefined,
    tone: seedForm.tone.trim() || undefined,
    references: seedForm.references.trim() || undefined,
    taboos: seedForm.taboos.trim() || undefined,
    draft: seedForm.draft.trim() || undefined,
  })

  const masterPlanFromData = (): MasterPlan => ({
    masterOutline: novel.masterOutline ?? '',
    volumes: vols.map((v) => ({
      title: v.vol.title,
      summary: v.vol.summary,
      goal: v.vol.goal,
      climax: v.vol.climax,
      endingHook: v.vol.endingHook,
      estimatedChapters: v.vol.estimatedChapters,
      targetWordCount: v.vol.targetWordCount,
    })),
  })

  const pushHistory = (label: string, detail: string, applied: boolean) => {
    setHistory((prev) =>
      [
        {
          id: crypto.randomUUID(),
          at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
          label,
          detail,
          applied,
        },
        ...prev,
      ].slice(0, 8),
    )
  }

  const proposalFrom = (p: PlannerProgress): Proposal | null => {
    if (p.proposal) {
      return {
        kind: 'seed',
        data: p.proposal,
        draft: {
          title: p.proposal.titles[0] ?? novel.title,
          genre: p.proposal.genre,
          premise: p.proposal.premise,
          characters: clone(p.proposal.characters),
        },
      }
    }
    if (p.masterPlan) {
      return { kind: 'master', data: p.masterPlan, draft: clone(p.masterPlan) }
    }
    if (p.chapterSkeletons && targetVolume) {
      return {
        kind: 'volume-chapters',
        data: p.chapterSkeletons,
        draft: clone(p.chapterSkeletons),
        volumeId: targetVolume.vol.id,
        volumeTitle: targetVolume.vol.title,
      }
    }
    if (p.chapterDetail && targetChapter) {
      return {
        kind: 'chapter-detail',
        data: p.chapterDetail,
        draft: clone(p.chapterDetail),
        chapterId: targetChapter.chapter.id,
        chapterTitle: targetChapter.chapter.title,
      }
    }
    if (p.review) {
      return {
        kind: 'review',
        data: p.review,
        selected: Object.fromEntries(
          p.review.issues.filter((i) => i.patch).map((i) => [i.id, true]),
        ),
      }
    }
    if (p.diff) {
      return {
        kind: 'calibrate',
        data: p.diff,
        selected: Object.fromEntries(p.diff.items.map((i) => [i.chapterId, true])),
        hooks: Object.fromEntries(
          p.diff.items.map((i) => [i.chapterId, [...i.newHooks]]),
        ),
      }
    }
    return null
  }

  const runGen = async (
    runner: (signal: AbortSignal) => AsyncGenerator<PlannerProgress>,
  ) => {
    if (running) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunning(true)
    setFinished(false)
    setError(null)
    setProposal(null)
    setProgress('准备中…')
    try {
      for await (const p of runner(controller.signal)) {
        if (p.message) setProgress(p.message)
        if (p.phase === 'error') {
          setError(p.message || '生成失败，请重试')
          setRunning(false)
          return
        }
        if (p.phase === 'done') {
          const next = proposalFrom(p)
          if (!next) {
            setError('AI 返回了无法识别的提案')
            setRunning(false)
            return
          }
          setProposal(next)
          setProgress('已完成，等待采纳')
          setFinished(true)
          pushHistory(`生成 · ${modeLabel(next.kind)}`, proposalSummary(next), false)
          setRunning(false)
          return
        }
      }
      if (controller.signal.aborted) setProgress('已停止')
      setRunning(false)
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      if (err?.name === 'AbortError') setProgress('已停止')
      else setError(`生成失败：${err?.message ?? String(e)}`)
      setRunning(false)
    } finally {
      abortRef.current = null
    }
  }

  const proposalSummary = (p: Proposal): string => {
    switch (p.kind) {
      case 'seed':
        return `书名「${p.draft.title}」，${p.draft.characters.length} 位角色`
      case 'master':
        return `${p.draft.volumes.length} 卷，主线 ${p.draft.masterOutline.length} 字`
      case 'volume-chapters':
        return `《${p.volumeTitle}》${p.draft.length} 章骨架`
      case 'chapter-detail':
        return `《${p.chapterTitle}》${p.draft.hooks.length} 条细纲`
      case 'review':
        return `评分 ${p.data.score}，${p.data.issues.length} 条问题`
      case 'calibrate':
        return `${p.data.items.length} 章需要调整`
    }
  }

  const generate = () => {
    if (running) return
    setError(null)
    if (mode === 'seed') {
      void runGen((signal) =>
        draftOutlineSeed(novelId, seedOutlineFrom(seedForm), signal, notes),
      )
      return
    }
    if (mode === 'master') {
      void runGen((signal) => draftMasterPlan(novelId, confirmedSeed(), signal, notes))
      return
    }
    if (mode === 'volume-chapters') {
      if (!targetVolume) {
        setError('请先建卷，再生成章纲')
        return
      }
      const index = vols.findIndex((v) => v.vol.id === targetVolume.vol.id)
      if (index < 0) {
        setError('找不到目标卷')
        return
      }
      void runGen((signal) =>
        draftVolumeChapters(novelId, confirmedSeed(), masterPlanFromData(), index, signal, notes),
      )
      return
    }
    if (mode === 'chapter-detail') {
      if (!targetChapter) {
        setError('请先选中一章')
        return
      }
      if (targetChapter.chapter.wordCount > 0) {
        setError('该章已有正文，不能再生成细纲')
        return
      }
      void runGen((signal) =>
        draftChapterDetail(novelId, targetChapter.chapter.id, signal, notes),
      )
      return
    }
    if (mode === 'review') {
      void runGen((signal) => reviewOutline(novelId, signal, notes))
      return
    }
    void runGen((signal) => calibrateOutline(novelId, notes, signal))
  }

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
    setProgress('已停止')
  }

  const adopt = async () => {
    if (!proposal || applying || running) return
    setApplying(true)
    setError(null)
    try {
      let message = ''
      await onBeforeAdopt()
      if (proposal.kind === 'seed') {
        // 采纳即视为确认：作者没填的基调取 AI 提案，避免后续主线生成丢失
        const tone =
          seedForm.tone.trim() ||
          [proposal.data.tone, proposal.data.audience].filter(Boolean).join('，')
        const r = await applySeedProposal(novelId, {
          ...proposal.draft,
          worldview: seedForm.worldview,
          setting: seedForm.setting,
          power: seedForm.power,
          tone,
          worldAnchors: proposal.data.worldAnchors,
        })
        // 采纳后让素材区与已落库内容保持一致，避免后续主线生成拿到旧值
        const lead = proposal.draft.characters.find((c) => c.role === 'protagonist')
        const rest = proposal.draft.characters.filter((c) => c !== lead)
        onSeedFormChange({
          title: proposal.draft.title,
          genre: proposal.draft.genre,
          premise: proposal.draft.premise,
          ...(seedForm.coreConflict.trim() || !proposal.data.coreConflict
            ? {}
            : { coreConflict: proposal.data.coreConflict }),
          ...(tone && !seedForm.tone.trim() ? { tone } : {}),
          ...(seedForm.sellingPoints.trim() || !proposal.data.sellingPoints?.length
            ? {}
            : { sellingPoints: proposal.data.sellingPoints.join('\n') }),
          ...(lead
            ? { protagonist: `${lead.name}${lead.profile ? ` —— ${lead.profile}` : ''}` }
            : {}),
          characters: rest
            .map((c) => `${c.name}（${roleLabel(c.role)}）${c.profile ? ` —— ${c.profile}` : ''}`)
            .join('\n'),
        })
        const fields = [r.title && '书名', r.genre && '类型', r.description && '梗概']
          .filter(Boolean)
          .join(' / ')
        const extras = [
          r.characters ? `${r.characters} 位角色` : '',
          r.worldviews ? `${r.worldviews} 条世界观` : '',
        ].filter(Boolean)
        message = `已采纳${fields ? `：更新${fields}` : ''}${extras.length ? `，新增 ${extras.join('、')}` : ''}`
      } else if (proposal.kind === 'master') {
        await novelService.update(novelId, { masterOutline: proposal.draft.masterOutline })
        if (vols.length === 0) {
          await applyProspectiveOutline(novelId, {
            confirmed: confirmedSeed(),
            masterPlan: proposal.draft,
            firstVolumeChapters: [],
          })
          message = `已写入主线与 ${proposal.draft.volumes.length} 卷`
        } else {
          await knowledgeService.syncOutline(novelId)
          message = '已更新全书主线；已有分卷未改动'
        }
      } else if (proposal.kind === 'volume-chapters') {
        const n = await applyVolumeChapters(
          novelId,
          proposal.volumeId,
          proposal.draft,
        )
        message = `已追加 ${n} 章到《${proposal.volumeTitle}》`
      } else if (proposal.kind === 'chapter-detail') {
        const ok = await applyChapterDetail(proposal.chapterId, proposal.draft)
        if (!ok) throw new Error('该章已有正文，提案未写入')
        message = `已写入《${proposal.chapterTitle}》的摘要与细纲`
      } else if (proposal.kind === 'review') {
        const issues: OutlineReviewIssue[] = proposal.data.issues
          .filter((i) => i.patch && proposal.selected[i.id])
          .map((i) => ({
            ...i,
            patch: {
              ...(i.patch?.summary ? { summary: i.patch.summary } : {}),
              ...(i.patch?.hooks ? { hooks: i.patch.hooks } : {}),
            },
          }))
        const n = await applyReviewPatches(issues, vols)
        message = n > 0 ? `已应用 ${n} 条补丁` : '没有可应用的补丁'
      } else {
        const items = proposal.data.items
          .filter((i) => proposal.selected[i.chapterId])
          .map((i) => ({
            ...i,
            newHooks: proposal.hooks[i.chapterId] ?? i.newHooks,
          }))
        const n = await applyCalibration(items)
        message = `已更新 ${n} 章的细纲`
      }

      pushHistory(`采纳 · ${modeLabel(proposal.kind)}`, message, true)
      setProposal(null)
      setFinished(false)
      setProgress('')
      await onApplied()
      onToast(message, 'ok')
    } catch (e: unknown) {
      const err = e as { message?: string }
      setError(`采纳失败：${err?.message ?? String(e)}`)
    } finally {
      setApplying(false)
    }
  }

  const discard = () => {
    setProposal(null)
    setFinished(false)
    setProgress('')
    setError(null)
  }

  const scopeText = (() => {
    if (mode === 'seed') return '作用范围：全书立项'
    if (mode === 'master') return '作用范围：全书主线与分卷'
    if (mode === 'volume-chapters') {
      return targetVolume
        ? `作用范围：第${targetVolume.vol.order}卷《${targetVolume.vol.title}》· 预计 ${
            targetVolume.vol.estimatedChapters || Math.max(6, targetVolume.chapters.length || 10)
          } 章`
        : '作用范围：暂无分卷'
    }
    if (mode === 'chapter-detail') {
      return targetChapter
        ? `作用范围：第${targetChapter.chapter.order}章《${targetChapter.chapter.title}》`
        : '作用范围：暂无章节'
    }
    const chapterCount = vols.reduce((sum, v) => sum + v.chapters.length, 0)
    return `作用范围：全书 ${vols.length} 卷 · ${chapterCount} 章`
  })()

  const canAdopt =
    !!proposal &&
    !applying &&
    !running &&
    (proposal.kind !== 'volume-chapters' || proposal.draft.length > 0) &&
    (proposal.kind !== 'review' ||
      Object.values(proposal.selected).some(Boolean)) &&
    (proposal.kind !== 'calibrate' ||
      Object.values(proposal.selected).some(Boolean))

  const adoptLabel =
    proposal && (proposal.kind === 'review' || proposal.kind === 'calibrate')
      ? '应用选中'
      : '采纳提案'

  const selectedCount =
    proposal && (proposal.kind === 'review' || proposal.kind === 'calibrate')
      ? Object.values(proposal.selected).filter(Boolean).length
      : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2.5">
        <Sparkles size={13} className="text-violet-300" />
        <span className="text-xs font-semibold text-foreground">AI 规划</span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px]',
            agentReady === false
              ? 'bg-amber-500/10 text-amber-300'
              : 'bg-emerald-500/10 text-emerald-300',
          )}
        >
          <span
            className={cn(
              'h-1 w-1 rounded-full',
              agentReady === false ? 'bg-amber-400' : 'bg-emerald-400',
            )}
          />
          {agentReady === null ? '检查中' : agentReady ? '已连接' : '未配置'}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {agentReady === false && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10px] leading-relaxed text-amber-300/90">
            还没有可用的 Agent 配置。手工编辑不受影响；要让 AI 提案，请先去
            <button
              onClick={() => navigate('/settings')}
              className="mx-1 inline-flex items-center gap-0.5 text-amber-200 underline underline-offset-2"
            >
              <Settings size={9} /> 设置
            </button>
            添加 Agent。
          </div>
        )}

        <div>
          <p className={labelCls}>规划模式</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PLAN_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => onModeChange(m.id)}
                title={m.desc}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-left transition-colors',
                  mode === m.id
                    ? 'border-violet-500/50 bg-violet-500/15'
                    : 'border-border/45 bg-muted/15 hover:bg-muted/35',
                )}
              >
                <span
                  className={cn(
                    'block text-[11px] font-medium',
                    mode === m.id ? 'text-violet-200' : 'text-foreground/85',
                  )}
                >
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[9px] text-muted-foreground/70">{m.scope}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/40 bg-muted/10 px-2.5 py-2 text-[10px] text-muted-foreground">
          {scopeText}
        </div>

        {(mode === 'seed' || mode === 'master') && (
          <div className="rounded-lg border border-border/40 bg-muted/10 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            书名、角色、世界观等线索在编辑区「创作线索」里填写，AI 只补全空白部分；逐块规划的口味与禁忌写在「AI 规划方向」里，总规划可在下方「本次要求」补充。
          </div>
        )}

        <div>
          <p className={labelCls}>本次要求（可选）</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="例如：前三章要快节奏；女主不要恋爱脑；第二卷加入宗门大比"
            className={textareaCls}
          />
        </div>

        {running ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-500/10 px-3 py-2 text-[11px] text-violet-200">
              <Loader2 size={12} className="animate-spin flex-shrink-0" />
              <span className="flex-1 truncate">{progress || '生成中…'}</span>
              <button
                onClick={stop}
                className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-[10px] text-red-300 hover:bg-red-500/25"
              >
                <Square size={8} /> 停止
              </button>
            </div>
          </div>
        ) : (
          <Button
            className="w-full bg-violet-600 text-white hover:bg-violet-500"
            size="sm"
            onClick={generate}
          >
            <Wand2 size={12} className="mr-1.5" />
            {proposal ? '换一批提案' : '生成提案'}
          </Button>
        )}

        {finished && !error && (
          <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] text-emerald-300">
            <CheckCircle2 size={11} /> 提案已生成，确认后再写入本地大纲
          </div>
        )}

        {error && (
          <div className="flex items-start gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-300">
            <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200">
              <X size={10} />
            </button>
          </div>
        )}

        {proposal && (
          <div className="rounded-xl border border-violet-500/25 bg-violet-500/[0.04]">
            <div className="flex items-center gap-1.5 border-b border-violet-500/15 px-3 py-2">
              <Wand2 size={11} className="text-violet-300" />
              <span className="text-[11px] font-medium text-violet-200">
                {modeLabel(proposal.kind)} · 提案
              </span>
              <span className="ml-auto text-[9px] text-muted-foreground/70">
                可编辑后采纳
              </span>
            </div>

            <div className="max-h-[46vh] overflow-y-auto px-3 py-3 space-y-3">
              <ProposalWarnings proposal={proposal} />
              <ProposalEditor
                proposal={proposal}
                vols={vols}
                onChange={(next) => setProposal(next)}
                onSelect={onSelect}
              />
            </div>

            <div className="space-y-1.5 border-t border-violet-500/15 px-3 py-2.5">
              {(proposal.kind === 'review' || proposal.kind === 'calibrate') && (
                <p className="text-[9px] text-muted-foreground/70">
                  已选 {selectedCount} 项；只有未写章会被写入。
                </p>
              )}
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="flex-1 bg-violet-600 text-white hover:bg-violet-500"
                  disabled={!canAdopt}
                  onClick={adopt}
                >
                  {applying ? (
                    <Loader2 size={11} className="mr-1 animate-spin" />
                  ) : (
                    <Check size={11} className="mr-1" />
                  )}
                  {applying ? '写入中…' : adoptLabel}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={running}
                  onClick={generate}
                  title="重新生成"
                >
                  <RefreshCw size={11} />
                </Button>
                <Button size="sm" variant="ghost" disabled={running} onClick={discard}>
                  放弃
                </Button>
              </div>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="border-t border-border/40 pt-2">
            <button
              onClick={() => setShowHistory((v) => !v)}
              className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <History size={10} />
              本次会话记录（{history.length}）
              {showHistory ? <ChevronDown size={10} className="ml-auto" /> : <ChevronRight size={10} className="ml-auto" />}
            </button>
            {showHistory && (
              <div className="mt-1.5 space-y-1">
                {history.map((h) => (
                  <div
                    key={h.id}
                    className="rounded-md bg-muted/20 px-2 py-1.5 text-[10px] leading-relaxed"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground/60">{h.at}</span>
                      <span className={h.applied ? 'text-emerald-300' : 'text-foreground/80'}>
                        {h.label}
                      </span>
                      {h.applied && <Check size={9} className="text-emerald-400" />}
                    </div>
                    <p className="mt-0.5 text-muted-foreground/75">{h.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ProposalWarnings({ proposal }: { proposal: Proposal }) {
  const warnings =
    proposal.kind === 'seed'
      ? proposal.data.warnings
      : proposal.kind === 'chapter-detail'
        ? proposal.data.warnings
        : proposal.kind === 'review'
          ? proposal.data.warnings
          : []
  const list = (warnings ?? []).filter(Boolean)
  if (list.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
      <p className="flex items-center gap-1 text-[10px] font-medium text-amber-300">
        <AlertTriangle size={10} /> 假设与提醒
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px] leading-relaxed text-amber-200/80">
        {list.slice(0, 6).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  )
}

function ProposalEditor({
  proposal,
  vols,
  onChange,
  onSelect,
}: {
  proposal: Proposal
  vols: VolChap[]
  onChange: (next: Proposal) => void
  onSelect: (selection: PlanSelection) => void
}) {
  if (proposal.kind === 'seed') {
    const d = proposal.draft
    return (
      <div className="space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className={labelCls}>书名</p>
            <input
              value={d.title}
              onChange={(e) => onChange({ ...proposal, draft: { ...d, title: e.target.value } })}
              className={inputCls}
            />
          </div>
          <div>
            <p className={labelCls}>类型</p>
            <input
              value={d.genre}
              onChange={(e) => onChange({ ...proposal, draft: { ...d, genre: e.target.value } })}
              className={inputCls}
            />
          </div>
        </div>
        {proposal.data.titles.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {proposal.data.titles.map((t) => (
              <button
                key={t}
                onClick={() => onChange({ ...proposal, draft: { ...d, title: t } })}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px]',
                  d.title === t
                    ? 'border-violet-400/60 bg-violet-500/20 text-violet-200'
                    : 'border-border/50 text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        <div>
          <p className={labelCls}>梗概</p>
          <textarea
            value={d.premise}
            onChange={(e) => onChange({ ...proposal, draft: { ...d, premise: e.target.value } })}
            rows={3}
            className={textareaCls}
          />
        </div>
        {proposal.data.synopsis && (
          <div className="rounded-md bg-muted/20 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            <span className="text-foreground/70">简介建议：</span>
            {proposal.data.synopsis}
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">角色阵容</p>
            <button
              onClick={() =>
                onChange({
                  ...proposal,
                  draft: {
                    ...d,
                    characters: [...d.characters, { name: '', role: 'supporting', profile: '' }],
                  },
                })
              }
              className="flex items-center gap-0.5 text-[10px] text-violet-300 hover:text-violet-200"
            >
              <Plus size={9} /> 添加
            </button>
          </div>
          <div className="space-y-1.5">
            {d.characters.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  value={c.name}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: {
                        ...d,
                        characters: d.characters.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      },
                    })
                  }
                  placeholder="名字"
                  className={cn(inputCls, 'w-20 flex-shrink-0')}
                />
                <select
                  value={c.role}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: {
                        ...d,
                        characters: d.characters.map((x, j) =>
                          j === i ? { ...x, role: e.target.value as ProposedCharacter['role'] } : x,
                        ),
                      },
                    })
                  }
                  className={cn(inputCls, 'w-16 flex-shrink-0 px-1')}
                >
                  <option value="protagonist">主角</option>
                  <option value="antagonist">反派</option>
                  <option value="supporting">配角</option>
                </select>
                <input
                  value={c.profile}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: {
                        ...d,
                        characters: d.characters.map((x, j) =>
                          j === i ? { ...x, profile: e.target.value } : x,
                        ),
                      },
                    })
                  }
                  placeholder="身份 / 性格 / 与主线的关系"
                  className={cn(inputCls, 'flex-1 min-w-0')}
                />
                <button
                  onClick={() =>
                    onChange({
                      ...proposal,
                      draft: {
                        ...d,
                        characters: d.characters.filter((_, j) => j !== i),
                      },
                    })
                  }
                  className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
        {(proposal.data.worldAnchors?.length || proposal.data.sellingPoints?.length) && (
          <div className="space-y-1.5 rounded-md bg-muted/15 px-2 py-1.5 text-[10px] text-muted-foreground">
            {proposal.data.worldAnchors?.length ? (
              <p>
                <span className="text-foreground/70">世界锚点：</span>
                {proposal.data.worldAnchors.join('；')}
              </p>
            ) : null}
            {proposal.data.sellingPoints?.length ? (
              <p>
                <span className="text-foreground/70">卖点：</span>
                {proposal.data.sellingPoints.join('；')}
              </p>
            ) : null}
          </div>
        )}
      </div>
    )
  }

  if (proposal.kind === 'master') {
    const d = proposal.draft
    return (
      <div className="space-y-2.5">
        <div>
          <p className={labelCls}>全书主线</p>
          <textarea
            value={d.masterOutline}
            onChange={(e) =>
              onChange({ ...proposal, draft: { ...d, masterOutline: e.target.value } })
            }
            rows={7}
            className={textareaCls}
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] text-muted-foreground">分卷规划（{d.volumes.length} 卷）</p>
            <button
              onClick={() =>
                onChange({
                  ...proposal,
                  draft: {
                    ...d,
                    volumes: [...d.volumes, { title: '', summary: '' }],
                  },
                })
              }
              className="flex items-center gap-0.5 text-[10px] text-violet-300 hover:text-violet-200"
            >
              <Plus size={9} /> 添加一卷
            </button>
          </div>
          <div className="space-y-2">
            {d.volumes.map((v, i) => (
              <div key={i} className="rounded-lg border border-border/40 bg-muted/10 p-2 space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="w-10 flex-shrink-0 text-[10px] text-muted-foreground">
                    第{i + 1}卷
                  </span>
                  <input
                    value={v.title}
                    onChange={(e) =>
                      onChange({
                        ...proposal,
                        draft: {
                          ...d,
                          volumes: d.volumes.map((x, j) =>
                            j === i ? { ...x, title: e.target.value } : x,
                          ),
                        },
                      })
                    }
                    placeholder="卷名"
                    className={inputCls}
                  />
                  <button
                    onClick={() =>
                      onChange({
                        ...proposal,
                        draft: { ...d, volumes: d.volumes.filter((_, j) => j !== i) },
                      })
                    }
                    className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
                <textarea
                  value={v.summary}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: {
                        ...d,
                        volumes: d.volumes.map((x, j) =>
                          j === i ? { ...x, summary: e.target.value } : x,
                        ),
                      },
                    })
                  }
                  rows={2}
                  placeholder="卷纲：本卷起止、主线推进、卷尾钩子"
                  className={textareaCls}
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    value={v.goal ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...proposal,
                        draft: {
                          ...d,
                          volumes: d.volumes.map((x, j) =>
                            j === i ? { ...x, goal: e.target.value } : x,
                          ),
                        },
                      })
                    }
                    placeholder="卷目标"
                    className={inputCls}
                  />
                  <input
                    value={v.endingHook ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...proposal,
                        draft: {
                          ...d,
                          volumes: d.volumes.map((x, j) =>
                            j === i ? { ...x, endingHook: e.target.value } : x,
                          ),
                        },
                      })
                    }
                    placeholder="卷尾钩子"
                    className={inputCls}
                  />
                  <input
                    type="number"
                    min={0}
                    value={v.estimatedChapters ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...proposal,
                        draft: {
                          ...d,
                          volumes: d.volumes.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  estimatedChapters: e.target.value ? +e.target.value : undefined,
                                }
                              : x,
                          ),
                        },
                      })
                    }
                    placeholder="预计章数"
                    className={inputCls}
                  />
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={v.targetWordCount ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...proposal,
                        draft: {
                          ...d,
                          volumes: d.volumes.map((x, j) =>
                            j === i
                              ? {
                                  ...x,
                                  targetWordCount: e.target.value ? +e.target.value : undefined,
                                }
                              : x,
                          ),
                        },
                      })
                    }
                    placeholder="目标字数"
                    className={inputCls}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        {vols.length > 0 && (
          <p className="rounded-md bg-amber-500/5 px-2 py-1.5 text-[10px] leading-relaxed text-amber-300/80">
            本书已有 {vols.length} 卷：采纳时只更新全书主线，不会追加或删除现有卷。
          </p>
        )}
      </div>
    )
  }

  if (proposal.kind === 'volume-chapters') {
    const d = proposal.draft
    return (
      <div className="space-y-2">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          将追加到《{proposal.volumeTitle}》末尾，共 {d.length} 章；已写章不会被改动。
        </p>
        <div className="space-y-1.5">
          {d.map((c, i) => (
            <div key={i} className="rounded-lg border border-border/40 bg-muted/10 p-2 space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="w-5 flex-shrink-0 text-[10px] text-muted-foreground">{i + 1}.</span>
                <input
                  value={c.title}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: d.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    })
                  }
                  placeholder="章名"
                  className={inputCls}
                />
                <input
                  type="number"
                  min={500}
                  max={20000}
                  step={500}
                  value={c.targetWordCount ?? 3000}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      draft: d.map((x, j) =>
                        j === i ? { ...x, targetWordCount: +e.target.value } : x,
                      ),
                    })
                  }
                  className={cn(inputCls, 'w-20 flex-shrink-0')}
                />
                <button
                  onClick={() =>
                    onChange({ ...proposal, draft: d.filter((_, j) => j !== i) })
                  }
                  className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
                >
                  <Trash2 size={10} />
                </button>
              </div>
              <textarea
                value={c.hooks.join('\n')}
                onChange={(e) =>
                  onChange({
                    ...proposal,
                    draft: d.map((x, j) =>
                      j === i
                        ? { ...x, hooks: e.target.value.split('\n') }
                        : x,
                    ),
                  })
                }
                rows={2}
                placeholder="一句话骨架：本章发生什么 / 推进什么 / 留下什么钩子"
                className={textareaCls}
              />
            </div>
          ))}
        </div>
        <button
          onClick={() =>
            onChange({
              ...proposal,
              draft: [...d, { title: '', hooks: [], targetWordCount: 3000 }],
            })
          }
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/50 py-1.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <Plus size={9} /> 添加一章
        </button>
      </div>
    )
  }

  if (proposal.kind === 'chapter-detail') {
    const d = proposal.draft
    return (
      <div className="space-y-2.5">
        <div>
          <p className={labelCls}>章摘要</p>
          <textarea
            value={d.summary}
            onChange={(e) =>
              onChange({ ...proposal, draft: { ...d, summary: e.target.value } })
            }
            rows={3}
            className={textareaCls}
          />
        </div>
        <div>
          <p className={labelCls}>细纲 hooks（一行一条）</p>
          <textarea
            value={d.hooks.join('\n')}
            onChange={(e) =>
              onChange({
                ...proposal,
                draft: { ...d, hooks: e.target.value.split('\n') },
              })
            }
            rows={5}
            className={textareaCls}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className={labelCls}>目标字数</p>
            <input
              type="number"
              min={500}
              max={20000}
              step={500}
              value={d.targetWordCount}
              onChange={(e) =>
                onChange({
                  ...proposal,
                  draft: {
                    ...d,
                    targetWordCount: Math.max(500, Math.min(20000, +e.target.value || 3000)),
                  },
                })
              }
              className={inputCls}
            />
          </div>
          <div>
            <p className={labelCls}>承接说明</p>
            <input
              value={d.continuityNotes.join('；')}
              onChange={(e) =>
                onChange({
                  ...proposal,
                  draft: {
                    ...d,
                    continuityNotes: e.target.value
                      .split('；')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                })
              }
              className={inputCls}
            />
          </div>
        </div>
        <p className="rounded-md bg-emerald-500/5 px-2 py-1.5 text-[10px] leading-relaxed text-emerald-300/80">
          章节《{proposal.chapterTitle}》尚未动笔，采纳只写摘要、hooks 与目标字数。
        </p>
      </div>
    )
  }

  if (proposal.kind === 'review') {
    const review = proposal.data
    return (
      <div className="space-y-2.5">
        <div className="flex items-end gap-2">
          <span
            className={cn(
              'text-2xl font-semibold',
              review.score >= 80
                ? 'text-emerald-300'
                : review.score >= 60
                  ? 'text-amber-300'
                  : 'text-red-300',
            )}
          >
            {review.score}
          </span>
          <span className="pb-1 text-[10px] text-muted-foreground">/100</span>
          <p className="flex-1 pb-1 text-[10px] leading-relaxed text-muted-foreground">
            {review.summary}
          </p>
        </div>

        {!!review.deterministic?.length && (
          <div className="rounded-lg border border-border/40 bg-muted/15 px-2 py-1.5">
            <p className="text-[10px] font-medium text-foreground/80">结构体检</p>
            <ul className="mt-1 space-y-0.5">
              {review.deterministic.map((f, i) => (
                <li key={i} className="text-[10px] leading-relaxed text-muted-foreground">
                  <span className="text-amber-300">[{SEVERITY_LABEL[f.severity] ?? f.severity}]</span>{' '}
                  {f.location ? `${f.location}：` : ''}
                  {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1.5">
          {review.issues.map((issue) => {
            const checked = !!proposal.selected[issue.id]
            return (
              <div
                key={issue.id}
                className={cn(
                  'rounded-lg border px-2 py-1.5',
                  SEVERITY_CLASS[issue.severity] ?? 'border-border/40',
                )}
              >
                <div className="flex items-start gap-1.5">
                  {issue.patch ? (
                    <button
                      onClick={() =>
                        onChange({
                          ...proposal,
                          selected: { ...proposal.selected, [issue.id]: !checked },
                        })
                      }
                      className={cn(
                        'mt-0.5 h-3.5 w-3.5 flex-shrink-0 rounded border flex items-center justify-center',
                        checked ? 'border-violet-400 bg-violet-500/30' : 'border-border',
                      )}
                    >
                      {checked && <Check size={9} />}
                    </button>
                  ) : (
                    <span className="mt-1 h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-60" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-medium">{issue.title}</span>
                      <span className="rounded bg-black/15 px-1 text-[8px] opacity-80">
                        {SEVERITY_LABEL[issue.severity] ?? issue.severity}
                      </span>
                      {!issue.patch && (
                        <span className="text-[8px] opacity-60">仅建议</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[10px] leading-relaxed opacity-85">
                      {issue.description}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-relaxed opacity-70">
                      建议：{issue.suggestion}
                    </p>
                    {issue.patch && (
                      <p className="mt-0.5 text-[9px] opacity-60">
                        将写入：{issue.volumeOrder != null ? `第${issue.volumeOrder + 1}卷` : ''}
                        {issue.chapterOrder != null ? `第${issue.chapterOrder + 1}章` : ''}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {review.skipped ? (
          <p className="text-[10px] text-muted-foreground/70">
            有 {review.skipped} 条补丁指向已写章，已被拦截。
          </p>
        ) : null}
      </div>
    )
  }

  const diff = proposal.data
  return (
    <div className="space-y-2.5">
      <p className="text-[10px] leading-relaxed text-muted-foreground">{diff.summary}</p>
      {diff.items.map((item) => {
        const checked = !!proposal.selected[item.chapterId]
        const hooks = proposal.hooks[item.chapterId] ?? item.newHooks
        return (
          <div key={item.chapterId} className="rounded-lg border border-border/40 bg-muted/10 p-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  onChange({
                    ...proposal,
                    selected: { ...proposal.selected, [item.chapterId]: !checked },
                  })
                }
                className={cn(
                  'h-3.5 w-3.5 flex-shrink-0 rounded border flex items-center justify-center',
                  checked ? 'border-violet-400 bg-violet-500/30' : 'border-border',
                )}
              >
                {checked && <Check size={9} />}
              </button>
              <button
                onClick={() =>
                  onSelect({
                    kind: 'chapter',
                    volumeId: item.volumeId,
                    chapterId: item.chapterId,
                  })
                }
                className="text-[10px] font-medium text-foreground hover:text-primary"
              >
                第{item.volumeOrder}卷第{item.chapterOrder}章《{item.chapterTitle}》
              </button>
              <ChevronRight size={9} className="text-muted-foreground/50" />
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              <div>
                <p className="text-[9px] text-muted-foreground/70">原走向</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground line-through decoration-border">
                  {item.oldHooks.length ? item.oldHooks.join('；') : '（暂无）'}
                </p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/70">新走向</p>
                <textarea
                  value={hooks.join('\n')}
                  onChange={(e) =>
                    onChange({
                      ...proposal,
                      hooks: {
                        ...proposal.hooks,
                        [item.chapterId]: e.target.value.split('\n'),
                      },
                    })
                  }
                  rows={3}
                  className={textareaCls}
                />
              </div>
            </div>
            <p className="text-[9px] leading-relaxed text-muted-foreground/70">
              原因：{item.reason}
            </p>
            {!!item.rippleEffects?.length && (
              <p className="text-[9px] leading-relaxed text-amber-300/70">
                连带影响：{item.rippleEffects.join('；')}
              </p>
            )}
          </div>
        )
      })}
      {diff.skipped > 0 && (
        <p className="text-[10px] text-muted-foreground/70">
          有 {diff.skipped} 条改动指向已写章，已被拦截。
        </p>
      )}
    </div>
  )
}
