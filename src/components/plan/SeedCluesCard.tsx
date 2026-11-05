import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  RotateCcw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import type {
  Character,
  Novel,
  PlanCritiqueResult,
  PlanEvalSummary,
  SeedAssistField,
  SeedSuggestion,
} from '@shared/types'
import { draftSeedField, SEED_ASSIST_LABEL } from '@/services/outline-planner'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { seedFormFrom, seedOutlineFrom, type PlanMode, type SeedForm } from './plan-utils'

interface Props {
  novelId: string
  novel: Novel
  characters: Character[]
  seedForm: SeedForm
  onSeedFormChange: (patch: Partial<SeedForm>) => void
  onOpenAi: (mode: PlanMode) => void
}

type AssistState =
  | { status: 'loading' }
  | {
      status: 'done'
      suggestions: string[]
      items?: SeedSuggestion[]
      planEval?: PlanEvalSummary
      planCritique?: PlanCritiqueResult
      previousScore?: number
      rewritten?: boolean
      humanized?: boolean
      reason?: string
      warnings: string[]
    }
  | { status: 'error'; message: string }

/** 逐级推荐顺序：类型 → 书名 → 梗概 → 冲突 → 主角 → 世界 → 卖点 → 禁忌 */
const ASSIST_ORDER: SeedAssistField[] = [
  'genre',
  'title',
  'premise',
  'coreConflict',
  'protagonist',
  'characters',
  'worldview',
  'setting',
  'power',
  'sellingPoints',
  'tone',
  'references',
  'taboos',
]

const directionKey = (novelId: string) => `zx-plan-direction:${novelId}`
const readDirection = (novelId: string): string => {
  try {
    return window.localStorage.getItem(directionKey(novelId)) ?? ''
  } catch {
    return ''
  }
}
const writeDirection = (novelId: string, value: string) => {
  try {
    window.localStorage.setItem(directionKey(novelId), value)
  } catch {
    // 本地存储不可用时只保留本次会话输入
  }
}

const inputCls =
  'h-8 w-full rounded-md bg-muted/25 border border-border/50 px-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20'
const textareaCls =
  'w-full rounded-md bg-muted/25 border border-border/50 px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none leading-relaxed'

function Section({
  title,
  step,
  children,
}: {
  title: string
  step: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-500/15 text-[9px] text-violet-300">
          {step}
        </span>
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground">{title}</span>
        <div className="h-px flex-1 bg-border/40" />
      </div>
      {children}
    </div>
  )
}

function ClueField({
  field,
  label,
  hint,
  value,
  rows,
  placeholder,
  next,
  assist,
  running,
  onChange,
  onAssist,
  onDismiss,
}: {
  field: SeedAssistField
  label: string
  hint?: string
  value: string
  rows?: number
  placeholder: string
  next: boolean
  assist?: AssistState
  running: boolean
  onChange: (value: string) => void
  onAssist: () => void
  onDismiss: () => void
}) {
  return (
    <div className="rounded-lg border border-border/35 bg-background/20 p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] text-foreground/85">{label}</span>
        {hint && <span className="truncate text-[10px] text-muted-foreground/60">{hint}</span>}
        {next && (
          <span className="rounded-full bg-violet-500/15 px-1.5 py-px text-[9px] text-violet-300">
            下一步
          </span>
        )}
        <button
          type="button"
          onClick={onAssist}
          disabled={running}
          className={cn(
            'ml-auto inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors',
            running
              ? 'text-violet-300/60'
              : 'text-violet-300 hover:bg-violet-500/15 hover:text-violet-200',
          )}
          title={`让 AI 根据其他已填线索规划「${label}」`}
        >
          {running ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
          {running ? '规划中' : value.trim() ? '重新规划' : 'AI 规划'}
        </button>
      </div>

      {rows ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className={textareaCls}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputCls}
        />
      )}

      {assist && (
        <AssistPanel
          field={field}
          assist={assist}
          running={running}
          onApply={(s) => onChange(s)}
          onRetry={onAssist}
          onDismiss={onDismiss}
        />
      )}
    </div>
  )
}

function AssistPanel({
  field,
  assist,
  running,
  onApply,
  onRetry,
  onDismiss,
}: {
  field: SeedAssistField
  assist: AssistState
  running: boolean
  onApply: (value: string) => void
  onRetry: () => void
  onDismiss: () => void
}) {
  const [showAllFindings, setShowAllFindings] = useState(false)
  if (assist.status === 'loading') {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-violet-500/25 bg-violet-500/5 px-2 py-1.5 text-[10px] text-violet-200">
        <Loader2 size={10} className="animate-spin" />
        正在结合已填线索规划「{SEED_ASSIST_LABEL[field]}」…
      </div>
    )
  }
  if (assist.status === 'error') {
    return (
      <div className="mt-1.5 flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-red-300">
        <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
        <span className="flex-1">{assist.message}</span>
        <button type="button" onClick={onRetry} className="text-red-200 hover:text-red-100">
          <RotateCcw size={10} />
        </button>
        <button type="button" onClick={onDismiss} className="text-red-300/70 hover:text-red-200">
          <X size={10} />
        </button>
      </div>
    )
  }
  const items: SeedSuggestion[] = assist.items?.length
    ? assist.items
    : assist.suggestions.map((text) => ({ text }))
  const evalInfo = assist.planEval

  return (
    <div className="mt-1.5 rounded-md border border-violet-500/25 bg-violet-500/[0.05]">
      <div className="flex items-center gap-1.5 border-b border-violet-500/15 px-2 py-1">
        <Sparkles size={10} className="text-violet-300" />
        <span className="text-[10px] text-violet-200">AI 建议 · 点击采用</span>
        {evalInfo && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[9px]',
              evalInfo.blocking > 0
                ? 'bg-red-500/15 text-red-300'
                : evalInfo.score >= 70
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-amber-500/15 text-amber-300',
            )}
            title="规划体检分：综合新鲜度、可写性、连载性与贴合度"
          >
            体检 {evalInfo.score}
          </span>
        )}
        {assist.rewritten && (
          <span className="rounded-full bg-violet-500/15 px-1.5 py-px text-[9px] text-violet-200">
            已自动改写
          </span>
        )}
        {assist.humanized && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[9px] text-emerald-300">
            已按你的节奏改句
          </span>
        )}
        <button
          type="button"
          onClick={onRetry}
          disabled={running}
          className="ml-auto text-[9px] text-violet-300 hover:text-violet-200 disabled:opacity-50"
        >
          再想一批
        </button>
        <button type="button" onClick={onDismiss} className="text-violet-300/60 hover:text-violet-200">
          <X size={10} />
        </button>
      </div>

      {evalInfo && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 border-b border-violet-500/10 px-2 py-1 text-[9px] text-muted-foreground/70">
          <span>模板化 {evalInfo.metrics.clicheHits}</span>
          <span>
            可重复场面 {evalInfo.metrics.sceneCount}/{items.length}
          </span>
          <span>候选轴 {Math.round(evalInfo.metrics.axisDiversity * 100)}%</span>
          <span>功能位 {Math.round(evalInfo.metrics.functionPositionCoverage * 100)}%</span>
          {typeof assist.previousScore === 'number' && (
            <span
              className={cn(
                assist.previousScore < evalInfo.score
                  ? 'text-emerald-300/80'
                  : assist.previousScore > evalInfo.score
                    ? 'text-amber-300/80'
                    : undefined,
              )}
            >
              上次 {assist.previousScore}
            </span>
          )}
        </div>
      )}

      <div className="space-y-1 p-1.5">
        {items.map((item, i) => {
          const findings = (item.findings ?? []).filter((f) => f.severity !== 'info')
          const risky = findings.some((f) => f.severity === 'blocking')
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => onApply(item.text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onApply(item.text)
                }
              }}
              className={cn(
                'group w-full cursor-pointer rounded-md bg-background/40 px-2 py-1.5 text-left text-[11px] leading-relaxed text-foreground/85 hover:bg-violet-500/10',
                risky && 'border border-red-500/20',
              )}
            >
              <div className="mb-0.5 flex flex-wrap items-center gap-1">
                <Check size={10} className="flex-shrink-0 text-violet-300/60 group-hover:text-violet-200" />
                {item.axis && (
                  <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-200">
                    {item.axis}
                  </span>
                )}
                {item.scores && (
                  <span
                    className={cn(
                      'rounded px-1 py-px text-[9px]',
                      item.scores.overall >= 70
                        ? 'bg-emerald-500/12 text-emerald-300/90'
                        : 'bg-amber-500/12 text-amber-300/90',
                    )}
                    title={`新鲜 ${item.scores.freshness} · 可写 ${item.scores.writability} · 连载 ${item.scores.seriality} · 贴合 ${item.scores.fit}`}
                  >
                    {item.scores.overall}
                  </span>
                )}
                {(item.functionPositions ?? []).map((p) => (
                  <span key={p} className="rounded bg-sky-500/12 px-1 py-px text-[9px] text-sky-300/80">
                    {p}
                  </span>
                ))}
              </div>
              <span className="block max-h-64 overflow-y-auto whitespace-pre-wrap">{item.text}</span>
              {item.scene && (
                <span className="mt-1 block text-[10px] leading-relaxed text-muted-foreground/80">
                  场面：{item.scene}
                </span>
              )}
              {item.whyItWorks && (
                <span className="mt-0.5 block text-[9px] leading-relaxed text-muted-foreground/60">
                  {item.whyItWorks}
                </span>
              )}
              {findings.length > 0 && (
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {findings.slice(0, 3).map((f, k) => (
                    <span
                      key={k}
                      className={cn(
                        'rounded px-1 py-px text-[9px]',
                        f.severity === 'blocking'
                          ? 'bg-red-500/12 text-red-300/90'
                          : 'bg-amber-500/12 text-amber-300/80',
                      )}
                    >
                      {f.message}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )
        })}
      </div>
      {assist.planCritique && assist.planCritique.metrics.blockCount >= 2 && (
        <div className="border-t border-violet-500/15 px-2 py-1.5">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[10px] text-violet-200">整体体检</span>
            <span
              className={cn(
                'rounded-full px-1.5 py-px text-[9px]',
                assist.planCritique.findings.some((f) => f.severity === 'blocking')
                  ? 'bg-red-500/15 text-red-300'
                  : assist.planCritique.score >= 80
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300',
              )}
            >
              {assist.planCritique.score}
            </span>
            <span className="text-[9px] text-muted-foreground/60">
              有选择 {Math.round(assist.planCritique.metrics.decisionDensity * assist.planCritique.metrics.blockCount)}/
              {assist.planCritique.metrics.blockCount} 块
            </span>
            <span className="text-[9px] text-muted-foreground/60">
              落点 {assist.planCritique.metrics.endingVariety} 种
            </span>
            {assist.planCritique.metrics.repeatedPhraseCount > 0 && (
              <span className="text-[9px] text-muted-foreground/60">
                重复短语 {assist.planCritique.metrics.repeatedPhraseCount}
              </span>
            )}
          </div>
          {assist.planCritique.findings.length > 0 ? (
            <>
              <ul className="space-y-1">
                {(showAllFindings
                  ? assist.planCritique.findings
                  : assist.planCritique.findings.slice(0, 3)
                ).map((f, i) => (
                  <li
                    key={`${f.code}-${i}`}
                    className={cn(
                      'rounded px-1.5 py-1 text-[9px] leading-relaxed',
                      f.severity === 'blocking'
                        ? 'bg-red-500/10 text-red-300/90'
                        : 'bg-amber-500/10 text-amber-300/85',
                    )}
                  >
                    <span className="block">{f.message}</span>
                    {f.location && (
                      <span className="mt-0.5 block text-muted-foreground/65">位置：{f.location}</span>
                    )}
                    {f.evidence && (
                      <span className="mt-0.5 block text-muted-foreground/65">原文：{f.evidence}</span>
                    )}
                    {f.suggestion && (
                      <span className="mt-0.5 block text-violet-200/80">改法：{f.suggestion}</span>
                    )}
                  </li>
                ))}
              </ul>
              {assist.planCritique.findings.length > 3 && (
                <button
                  type="button"
                  onClick={() => setShowAllFindings((v) => !v)}
                  className="mt-1 text-[9px] text-violet-300 hover:text-violet-200"
                >
                  {showAllFindings
                    ? '收起'
                    : `查看全部 ${assist.planCritique.findings.length} 条`}
                </button>
              )}
            </>
          ) : (
            <p className="text-[9px] text-emerald-300/80">落点、冲突与决策分布没有明显同质化。</p>
          )}
        </div>
      )}
      {assist.reason && (
        <p className="border-t border-violet-500/15 px-2 py-1 text-[9px] leading-relaxed text-muted-foreground/70">
          {assist.reason}
        </p>
      )}
      {assist.warnings.length > 0 && (
        <ul className="space-y-0.5 border-t border-amber-500/15 px-2 py-1 text-[9px] leading-relaxed text-amber-300/80">
          {assist.warnings.slice(0, 4).map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function SeedCluesCard({
  novelId,
  novel,
  characters,
  seedForm,
  onSeedFormChange,
  onOpenAi,
}: Props) {
  const [assists, setAssists] = useState<Partial<Record<SeedAssistField, AssistState>>>({})
  const [runningField, setRunningField] = useState<SeedAssistField | null>(null)
  const [direction, setDirection] = useState('')
  const directionRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const next = readDirection(novelId)
    setDirection(next)
    directionRef.current = next
    return () => writeDirection(novelId, directionRef.current)
  }, [novelId])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    [],
  )

  const filled = useMemo(
    () => ASSIST_ORDER.filter((f) => (seedForm[f] as string).trim()).length,
    [seedForm],
  )
  const nextField = useMemo(
    () => ASSIST_ORDER.find((f) => !(seedForm[f] as string).trim()) ?? null,
    [seedForm],
  )

  const setField = (field: SeedAssistField, value: string) =>
    onSeedFormChange({ [field]: value } as Partial<SeedForm>)

  const updateDirection = (value: string) => {
    setDirection(value)
    directionRef.current = value
  }

  const clearAssist = (field: SeedAssistField) =>
    setAssists((prev) => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })

  const runAssist = async (field: SeedAssistField) => {
    if (runningField) return
    const controller = new AbortController()
    abortRef.current = controller
    setRunningField(field)
    setAssists((prev) => ({ ...prev, [field]: { status: 'loading' } }))
    try {
      const seed = seedOutlineFrom(seedForm)
      const notes = directionRef.current.trim() || undefined
      for await (const p of draftSeedField(novelId, field, seed, controller.signal, notes)) {
        if (p.phase === 'error') {
          setAssists((prev) => ({
            ...prev,
            [field]: { status: 'error', message: p.message || '规划失败，请重试' },
          }))
          return
        }
        if (p.phase === 'done' && p.assist) {
          setAssists((prev) => ({
            ...prev,
            [field]: {
              status: 'done',
              suggestions: p.assist!.suggestions,
              items: p.assist!.items,
              planEval: p.assist!.planEval,
              planCritique: p.assist!.planCritique,
              previousScore: p.assist!.previousScore,
              rewritten: p.assist!.rewritten,
              humanized: p.assist!.humanized,
              reason: p.assist!.reason,
              warnings: p.assist!.warnings ?? [],
            },
          }))
          return
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      if (err?.name === 'AbortError') {
        clearAssist(field)
      } else {
        setAssists((prev) => ({
          ...prev,
          [field]: { status: 'error', message: `规划失败：${err?.message ?? String(e)}` },
        }))
      }
    } finally {
      abortRef.current = null
      setRunningField(null)
    }
  }

  const fieldProps = (field: SeedAssistField) => ({
    field,
    label: SEED_ASSIST_LABEL[field],
    value: seedForm[field] as string,
    next: nextField === field,
    assist: assists[field],
    running: runningField === field,
    onChange: (v: string) => setField(field, v),
    onAssist: () => void runAssist(field),
    onDismiss: () => clearAssist(field),
  })

  return (
    <div className="rounded-xl border border-border/40 bg-muted/10 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-xs text-foreground">
            <Wand2 size={12} className="text-violet-300" />
            创作线索
            <span className="text-[10px] text-muted-foreground">
              已填 {filled}/{ASSIST_ORDER.length}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/70">
            每一块都能单独让 AI 规划，会结合其他已填内容、草稿区与下面的方向；按
            类型 → 书名 → 梗概 → 主角 → 世界观 → 卖点 逐级推进，也可随时回头重规划。
            AI 会给出不同轴的候选，并标注可重复场面与体检分。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const filledForm = seedFormFrom(novel, characters)
            onSeedFormChange({
              genre: filledForm.genre,
              title: filledForm.title,
              premise: filledForm.premise,
              protagonist: filledForm.protagonist,
              characters: filledForm.characters,
            })
          }}
          className="flex-shrink-0 text-[10px] text-violet-300 hover:text-violet-200"
        >
          用现有资料回填
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-2.5">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[10px] text-violet-200">AI 规划方向（可选）</span>
          <span className="text-[9px] text-muted-foreground/60">
            每次点任意块的 AI 规划都会带上
          </span>
        </div>
        <textarea
          value={direction}
          onChange={(e) => updateDirection(e.target.value)}
          onBlur={() => writeDirection(novelId, directionRef.current)}
          rows={2}
          placeholder="例如：中式轻小说、多女主、搞笑轻松，能力只服务日常暧昧和爽点；不要苦大仇深、枷锁、倒计时。也可以粘贴参考作品的段落或想要的场面。"
          className={textareaCls}
        />
      </div>

      <div className="mt-4 space-y-5">
        <Section title="定位" step="1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ClueField
              {...fieldProps('genre')}
              hint="先定类型，后续建议都会围绕它"
              placeholder="如 都市悬疑 / 玄幻"
            />
            <ClueField {...fieldProps('title')} placeholder="没想好可留空，让 AI 起名" />
          </div>
          <ClueField
            {...fieldProps('premise')}
            hint="谁 + 处境/能力 + 最抓人的关系或麻烦"
            rows={2}
            placeholder="第一句就写人物正在做的事：谁 + 做了什么 + 最抓人的关系或麻烦，最后停在一个动作或台词上。"
          />
          <ClueField
            {...fieldProps('coreConflict')}
            rows={2}
            placeholder="谁和谁在争什么，为什么好看或好笑；不用硬写悲剧代价。"
          />
        </Section>

        <Section title="人物" step="2">
          <ClueField
            {...fieldProps('protagonist')}
            hint="一个具体场面 + 一句台词，比字段清单更好"
            rows={2}
            placeholder="如 江砚转学第一天就把班主任的茶杯当成自己的，喝完还问要不要续；他嘴上说只想混到毕业。"
          />
          <ClueField
            {...fieldProps('characters')}
            hint="每行一个，写动作或台词，不写字段"
            rows={3}
            placeholder={'周砚收走转学名额时顺手把主角的名字念错，而且每年都念错\n许晚只在主角被罚站时出现，递给他一颗被捂热的糖'}
          />
        </Section>

        <Section title="世界" step="3">
          <ClueField
            {...fieldProps('worldview')}
            hint="力量体系、社会规则、关键地点；采纳时存为世界观条目"
            rows={3}
            placeholder={'力量体系：异能分五阶，越阶使用会折寿\n雾港：常年大雾，货船昼夜不停'}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ClueField
              {...fieldProps('setting')}
              hint="时代、地域与限制"
              rows={2}
              placeholder="如 近未来沿海城市，监控无处不在"
            />
            <ClueField
              {...fieldProps('power')}
              hint="金手指 / 核心能力，写清触发与用法"
              rows={2}
              placeholder="如 能看见他人三分钟后的死亡，触发条件与限制写清楚即可"
            />
          </div>
        </Section>

        <Section title="卖点与调性" step="4">
          <ClueField
            {...fieldProps('sellingPoints')}
            hint="一行一条，前三章至少兑现一个"
            rows={3}
            placeholder={'倒计时压迫感\n法医细节\n旧案反转'}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ClueField
              {...fieldProps('tone')}
              hint="存为世界观条目"
              placeholder="如 冷峻悬疑、面向成年读者"
            />
            <ClueField {...fieldProps('references')} placeholder="如 《长夜难明》《信号》" />
          </div>
          <ClueField
            {...fieldProps('taboos')}
            hint="明确不要写的东西"
            rows={2}
            placeholder={'不要恋爱主线\n不要无脑打脸\n主角不杀无辜'}
          />
        </Section>

        <Section title="篇幅" step="5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="mb-1 text-[10px] text-muted-foreground">期望卷数</p>
              <input
                type="number"
                min={0}
                value={seedForm.volCount}
                onChange={(e) => onSeedFormChange({ volCount: e.target.value })}
                placeholder="未设"
                className={inputCls}
              />
            </div>
            <div>
              <p className="mb-1 text-[10px] text-muted-foreground">期望总章数</p>
              <input
                type="number"
                min={0}
                value={seedForm.chCount}
                onChange={(e) => onSeedFormChange({ chCount: e.target.value })}
                placeholder="未设"
                className={inputCls}
              />
            </div>
          </div>
        </Section>

        <Section title="草稿区" step="6">
          <div className="rounded-lg border border-dashed border-amber-500/25 bg-amber-500/[0.03] p-2.5">
            <p className="mb-1.5 text-[10px] leading-relaxed text-amber-200/70">
              想到什么写什么：灵感、片段、对话、想写的场景都行。草稿会参与每一次 AI
              规划和最终立项生成，但不会自动写进正文。
            </p>
            <textarea
              value={seedForm.draft}
              onChange={(e) => onSeedFormChange({ draft: e.target.value })}
              rows={6}
              placeholder={
                '例如：\n主角第一次发现硬币会发烫，是在便利店关东煮的蒸汽里。\n想写一场雨夜追车，但不要真的撞车。\n结尾想留一个“监控少了 60 秒”的悬念。'
              }
              className={textareaCls}
            />
          </div>
        </Section>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
          <p className="text-[10px] text-muted-foreground/70">
            线索齐了以后，用总规划一次性生成立项提案；采纳前不会改动任何内容。
          </p>
          <Button size="sm" variant="outline" onClick={() => onOpenAi('seed')}>
            <Sparkles size={11} className="mr-1 text-violet-300" />
            生成完整提纲
          </Button>
        </div>
      </div>
    </div>
  )
}
