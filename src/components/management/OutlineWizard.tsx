/**
 * 新建大纲向导（8.13）：写作前的前瞻性大纲，四步走——
 * 1 创意提案（弹性输入，缺什么 AI 补什么）→ 2 主线分卷 → 3 章纲骨架 → 4 确认落库。
 * 每步产物均为「提案卡」：可重摇、可手改，用户确认后才进入下一步。
 * UI：嵌入 WorkbenchPage 的二级滑出层（标题栏/关闭由外层提供），本组件只负责步骤条 + 内容 + 底栏。
 */
import { useRef, useState, type ReactNode } from 'react'
import { Loader2, Plus, Trash2, Square, CheckCircle2, ChevronRight, Check, Wand2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import { draftOutlineSeed, draftMasterPlan, draftVolumeChapters, applyProspectiveOutline } from '@/services/outline-planner'
import type { OutlineSeedProposal, ProposedCharacter, MasterPlan, ChapterSkeleton } from '@shared/types'

const ROLE_LABEL: Record<ProposedCharacter['role'], string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
}
const ROLE_ORDER: ProposedCharacter['role'][] = ['protagonist', 'antagonist', 'supporting']

const STEPS = ['创意提案', '主线分卷', '章纲骨架', '确认落库']

interface Props {
  novelId: string
  existingChapters: number
  onClose: () => void
  onApplied: () => void
}

interface RunState {
  phase: 'idle' | 'running' | 'error'
  message: string
}

// —— house 风格表单（与 EditNovelDialog 一致）——
const inputCls =
  'w-full h-9 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 px-3 placeholder:text-muted-foreground/50'
const textareaCls =
  'w-full rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 p-2.5 resize-none placeholder:text-muted-foreground/50 leading-relaxed'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1 block">
        {label}
        {hint && <span className="ml-1.5 text-muted-foreground/60">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

export default function OutlineWizard({ novelId, existingChapters, onClose, onApplied }: Props) {
  const [step, setStep] = useState(1)

  // 第 1 步：弹性输入
  const [sTitle, setSTitle] = useState('')
  const [sGenre, setSGenre] = useState('')
  const [sChars, setSChars] = useState('')
  const [sPremise, setSPremise] = useState('')
  const [sVolCount, setSVolCount] = useState('')
  const [sChCount, setSChCount] = useState('')

  // 第 1 步提案 → 确认稿（可编辑）
  const [proposal, setProposal] = useState<OutlineSeedProposal | null>(null)
  const [cTitle, setCTitle] = useState('')
  const [cGenre, setCGenre] = useState('')
  const [cPremise, setCPremise] = useState('')
  const [cChars, setCChars] = useState<ProposedCharacter[]>([])
  const [cVolCount, setCVolCount] = useState(0)
  const [cChCount, setCChCount] = useState(0)

  // 第 2 步：主线分卷
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [masterOutlineText, setMasterOutlineText] = useState('')
  const [volumes, setVolumes] = useState<{ title: string; summary: string }[]>([])

  // 第 3 步：章纲骨架（skeletonVolIdx 记录当前骨架属于哪一卷，换卷后需重新生成）
  const [volIdx, setVolIdx] = useState(0)
  const [skeletons, setSkeletons] = useState<ChapterSkeleton[] | null>(null)
  const [skeletonVolIdx, setSkeletonVolIdx] = useState(-1)

  const [run, setRun] = useState<RunState>({ phase: 'idle', message: '' })
  const [applied, setApplied] = useState<{ volumes: number; chapters: number; characters: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const cancelRun = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setRun({ phase: 'idle', message: '' })
  }

  const runGen = async (
    task: (signal: AbortSignal) => AsyncGenerator<{ phase: string; message?: string; proposal?: OutlineSeedProposal; masterPlan?: MasterPlan; chapterSkeletons?: ChapterSkeleton[] }>,
    onDone: (p: any) => void,
  ) => {
    if (run.phase === 'running') return
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ phase: 'running', message: '准备中…' })
    try {
      for await (const p of task(controller.signal)) {
        setRun({ phase: 'running', message: p.message ?? '' })
        if (p.phase === 'error') { setRun({ phase: 'error', message: p.message ?? '失败，请重试' }); return }
        if (p.phase === 'done') { onDone(p); setRun({ phase: 'idle', message: '' }); return }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setRun({ phase: 'error', message: `错误：${e.message}` })
      else setRun({ phase: 'idle', message: '' })
    } finally {
      abortRef.current = null
    }
  }

  const confirmedNow = () => ({
    title: cTitle, genre: cGenre, premise: cPremise, characters: cChars,
    volumeCount: cVolCount, chapterCount: cChCount || undefined,
  })

  const runSeed = () =>
    runGen(
      (signal) => draftOutlineSeed(novelId, {
        title: sTitle.trim() || undefined,
        genre: sGenre.trim() || undefined,
        characters: sChars.trim() || undefined,
        premise: sPremise.trim() || undefined,
        volumeCount: +sVolCount || undefined,
        chapterCount: +sChCount || undefined,
      }, signal),
      (p) => {
        const prop = p.proposal!
        setProposal(prop)
        setCTitle(sTitle.trim() || prop.titles[0] || '')
        setCGenre(sGenre.trim() || prop.genre || '')
        setCPremise(sPremise.trim() || prop.premise || '')
        setCChars(prop.characters)
        setCVolCount(+sVolCount || 0)
        setCChCount(+sChCount || 0)
      },
    )

  const runMaster = () =>
    runGen(
      (signal) => draftMasterPlan(novelId, confirmedNow(), signal),
      (p) => {
        const plan = p.masterPlan!
        setMasterPlan(plan)
        setMasterOutlineText(plan.masterOutline)
        setVolumes(plan.volumes)
        setVolIdx(0)
        setSkeletons(null)
        setSkeletonVolIdx(-1)
      },
    )

  const runSkeletons = () => {
    const idx = volIdx
    runGen(
      (signal) => draftVolumeChapters(novelId, confirmedNow(), { masterOutline: masterOutlineText, volumes }, idx, signal),
      (p) => {
        setSkeletons(p.chapterSkeletons!)
        setSkeletonVolIdx(idx)
      },
    )
  }

  const runApply = async () => {
    if (run.phase === 'running' || applied) return
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ phase: 'running', message: '正在落库…' })
    try {
      const result = await applyProspectiveOutline(novelId, {
        confirmed: confirmedNow(),
        masterPlan: { masterOutline: masterOutlineText, volumes },
        firstVolumeChapters: skeletons ?? [],
      })
      setApplied(result)
      setRun({ phase: 'idle', message: '' })
    } catch (e: any) {
      setRun({ phase: 'error', message: `落库失败：${e.message}` })
    } finally {
      abortRef.current = null
    }
  }

  const canNext =
    step === 1 ? !!(cTitle.trim() && cPremise.trim())
    : step === 2 ? !!(masterOutlineText.trim() && volumes.some((v) => v.title.trim()))
    : step === 3 ? (skeletons?.length ?? 0) > 0
    : true

  return (
    <div className="h-full flex flex-col">
      {/* Stepper */}
      <div className="flex items-center px-5 py-3 border-b border-border/30 bg-muted/10 flex-shrink-0">
        {STEPS.map((label, i) => (
          <div key={label} className="contents">
            {i > 0 && <div className={cn('h-px flex-1 mx-2.5 transition-colors', step > i + 1 ? 'bg-emerald-500/40' : 'bg-border/60')} />}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium transition-colors',
                step === i + 1 ? 'bg-violet-500 text-white'
                  : step > i + 1 ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-muted/50 text-muted-foreground/70',
              )}>
                {step > i + 1 ? <Check size={10} /> : i + 1}
              </div>
              <span className={cn('text-xs', step === i + 1 ? 'text-foreground font-medium' : step > i + 1 ? 'text-emerald-400/90' : 'text-muted-foreground/70')}>
                {label}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* 已有内容提示 */}
      {existingChapters > 0 && (
        <div className="px-5 py-1.5 border-b border-amber-500/20 bg-amber-500/5 text-[10px] text-amber-400/90 flex-shrink-0">
          本书已有 {existingChapters} 章内容：落库将追加新卷，不动已写内容
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {step === 1 && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              想到什么填什么，空着的部分由 AI 提案补全——比如只填书名，或只写几个角色的名字。
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Field label="书名">
                <input value={sTitle} onChange={(e) => setSTitle(e.target.value)} placeholder="想好书名就填，没想好留空" className={inputCls} />
              </Field>
              <Field label="类型">
                <input value={sGenre} onChange={(e) => setSGenre(e.target.value)} placeholder="如：都市日常 / 玄幻 / 悬疑" className={inputCls} />
              </Field>
            </div>
            <Field label="主要角色" hint="每行一个：名字 —— 身份 / 性格">
              <textarea value={sChars} onChange={(e) => setSChars(e.target.value)} rows={3} placeholder={'江砚 —— 高三转学生，喜欢修旧钟表\n苏禾 —— 高二学生，看着软乎乎实际很硬'} className={textareaCls} />
            </Field>
            <Field label="故事梗概 / 点子">
              <textarea value={sPremise} onChange={(e) => setSPremise(e.target.value)} rows={3} placeholder="一句话或一段话都行，越具体提案越贴合" className={textareaCls} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="期望卷数" hint="可选">
                <input type="number" min={0} value={sVolCount} onChange={(e) => setSVolCount(e.target.value)} placeholder="由 AI 决定" className={inputCls} />
              </Field>
              <Field label="期望总章数" hint="可选">
                <input type="number" min={0} value={sChCount} onChange={(e) => setSChCount(e.target.value)} placeholder="由 AI 决定" className={inputCls} />
              </Field>
            </div>

            {proposal && (
              <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-4">
                <div className="flex items-center gap-1.5">
                  <Wand2 size={12} className="text-violet-300" />
                  <span className="text-xs font-medium text-violet-300">AI 提案</span>
                  <span className="text-[10px] text-muted-foreground">以下内容可直接修改，不满意可换一批</span>
                </div>
                {proposal.titles.length > 1 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground">书名备选</span>
                    {proposal.titles.map((t) => (
                      <button key={t} onClick={() => setCTitle(t)} className={cn('px-2.5 h-7 rounded-full text-xs border transition-colors', cTitle === t ? 'border-violet-400/60 bg-violet-500/20 text-violet-200' : 'border-border/50 text-muted-foreground hover:bg-muted/40 hover:text-foreground')}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <Field label="书名">
                    <input value={cTitle} onChange={(e) => setCTitle(e.target.value)} className={inputCls} />
                  </Field>
                  <Field label="类型">
                    <input value={cGenre} onChange={(e) => setCGenre(e.target.value)} className={inputCls} />
                  </Field>
                </div>
                <Field label="梗概">
                  <textarea value={cPremise} onChange={(e) => setCPremise(e.target.value)} rows={2} className={textareaCls} />
                </Field>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground">角色阵容</span>
                    <button onClick={() => setCChars([...cChars, { name: '', role: 'supporting', profile: '' }])} className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
                      <Plus size={11} /> 添加角色
                    </button>
                  </div>
                  <div className="space-y-2">
                    {cChars.map((c, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input value={c.name} onChange={(e) => setCChars(cChars.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="名字" className={cn(inputCls, 'w-28 flex-shrink-0')} />
                        <select value={c.role} onChange={(e) => setCChars(cChars.map((x, j) => j === i ? { ...x, role: e.target.value as ProposedCharacter['role'] } : x))} className={cn(inputCls, 'w-[4.5rem] flex-shrink-0 px-1.5')}>
                          {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                        <input value={c.profile} onChange={(e) => setCChars(cChars.map((x, j) => j === i ? { ...x, profile: e.target.value } : x))} placeholder="身份 / 性格 / 与主线的关系" className={cn(inputCls, 'flex-1 min-w-0')} />
                        <button onClick={() => setCChars(cChars.filter((_, j) => j !== i))} className="p-1.5 rounded-lg text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              基于上一步确认的立项信息，规划全书主线与分卷。这是写作前的走向规划，写正文后可随时用「重订走向」校准。
            </p>
            {!masterPlan && run.phase !== 'running' && (
              <button onClick={runMaster} className="w-full h-10 rounded-lg border border-dashed border-violet-500/40 bg-violet-500/5 text-sm text-violet-300 hover:bg-violet-500/10 transition-colors flex items-center justify-center gap-1.5">
                <Wand2 size={13} /> 生成主线与分卷
              </button>
            )}
            {masterPlan && (
              <div className="space-y-4">
                <Field label="全书主线" hint="核心冲突 / 成长线 / 关键转折 / 结局走向">
                  <textarea value={masterOutlineText} onChange={(e) => setMasterOutlineText(e.target.value)} rows={8} className={textareaCls} />
                </Field>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground">分卷规划（{volumes.length} 卷）</span>
                    <button onClick={() => setVolumes([...volumes, { title: '', summary: '' }])} className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
                      <Plus size={11} /> 添加一卷
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    {volumes.map((v, i) => (
                      <div key={i} className="rounded-xl border border-border/40 bg-muted/10 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="w-14 text-xs text-muted-foreground flex-shrink-0">第{i + 1}卷</span>
                          <input value={v.title} onChange={(e) => setVolumes(volumes.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} placeholder="卷名" className={cn(inputCls, 'w-48')} />
                          <button onClick={() => setVolumes(volumes.filter((_, j) => j !== i))} className="ml-auto p-1.5 rounded-lg text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <textarea value={v.summary} onChange={(e) => setVolumes(volumes.map((x, j) => j === i ? { ...x, summary: e.target.value } : x))} rows={2} placeholder="卷纲：本卷起止、主线推进、卷尾钩子" className={textareaCls} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              为选定卷生成「章名 + 一句话骨架」。骨架够用就好，写到哪一章再细化哪一章的细纲。
            </p>
            <div className="flex items-center gap-2.5">
              <span className="text-xs text-muted-foreground flex-shrink-0">目标卷</span>
              <select value={volIdx} onChange={(e) => setVolIdx(+e.target.value)} className={cn(inputCls, 'w-64')}>
                {volumes.map((v, i) => (
                  <option key={i} value={i}>第{i + 1}卷《{v.title || '未命名'}》</option>
                ))}
              </select>
              {run.phase !== 'running' && (
                <button onClick={runSkeletons} className="h-9 px-3 rounded-lg border border-violet-500/40 bg-violet-500/10 text-xs text-violet-300 hover:bg-violet-500/20 transition-colors flex items-center gap-1.5 flex-shrink-0">
                  <Wand2 size={11} />
                  {skeletons && skeletonVolIdx === volIdx ? '换一批' : '生成章纲骨架'}
                </button>
              )}
            </div>
            {skeletons && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">章纲骨架（{skeletons.length} 章）</span>
                  <button onClick={() => setSkeletons([...skeletons, { title: '', hooks: [] }])} className="flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
                    <Plus size={11} /> 添加一章
                  </button>
                </div>
                <div className="space-y-2">
                  {skeletons.map((c, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="w-7 h-9 flex items-center justify-center text-xs text-muted-foreground/70 flex-shrink-0">{i + 1}.</span>
                      <input value={c.title} onChange={(e) => setSkeletons(skeletons.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} placeholder="章名" className={cn(inputCls, 'w-44 flex-shrink-0')} />
                      <textarea
                        value={c.hooks.join('\n')}
                        onChange={(e) => setSkeletons(skeletons.map((x, j) => j === i ? { ...x, hooks: e.target.value.split('\n').filter((h) => h.trim()) } : x))}
                        rows={1}
                        placeholder="一句话骨架：本章发生什么 / 推进什么 / 留下什么钩子"
                        className={cn(textareaCls, 'flex-1 min-h-[36px] py-1.5')}
                      />
                      <button onClick={() => setSkeletons(skeletons.filter((_, j) => j !== i))} className="p-1.5 rounded-lg text-muted-foreground/60 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0 transition-colors mt-0.5">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            {applied ? (
              <div className="flex flex-col items-center justify-center py-14 space-y-3">
                <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
                  <CheckCircle2 size={28} className="text-emerald-400" />
                </div>
                <p className="text-base text-foreground font-semibold">大纲已落库</p>
                <p className="text-xs text-muted-foreground">
                  新建 {applied.volumes} 卷 · {applied.chapters} 章骨架 · {applied.characters} 位角色，主线已写入大纲文件
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground leading-relaxed">确认以下内容将写入本书：</p>
                {existingChapters > 0 && (
                  <div className="flex items-center gap-2 text-xs text-amber-400/90 bg-amber-500/5 border border-amber-500/25 rounded-lg px-3 py-2">
                    本书已有 {existingChapters} 章内容：新卷会追加在现有卷之后，已写章节与角色不会被改动（同名角色跳过）。
                  </div>
                )}
                <div className="rounded-xl border border-border/40 bg-muted/10 p-4 space-y-3 text-sm">
                  <div className="grid grid-cols-[4.5rem_1fr] gap-y-2.5 items-baseline">
                    <span className="text-xs text-muted-foreground">书名 / 类型</span>
                    <span className="text-foreground font-medium">{cTitle || '（未填）'}<span className="text-muted-foreground font-normal"> · {cGenre || '未分类'}</span></span>
                    <span className="text-xs text-muted-foreground">梗概</span>
                    <span className="text-foreground leading-relaxed">{cPremise || '（未填）'}</span>
                    <span className="text-xs text-muted-foreground">结构</span>
                    <span className="text-foreground">{volumes.length} 卷 · 第 1 卷 {skeletons?.length ?? 0} 章骨架</span>
                    {cChars.filter((c) => c.name.trim()).length > 0 && (
                      <>
                        <span className="text-xs text-muted-foreground">角色</span>
                        <div className="flex flex-wrap gap-1.5">
                          {cChars.filter((c) => c.name.trim()).map((c) => (
                            <span key={c.name} className="inline-flex items-center h-6 px-2 rounded-full bg-muted/40 border border-border/40 text-xs text-foreground">
                              {c.name}<span className="text-muted-foreground ml-1">{ROLE_LABEL[c.role]}</span>
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="pt-2 border-t border-border/30">
                    <span className="text-xs text-muted-foreground">主线预览</span>
                    <p className="text-xs text-muted-foreground/90 leading-relaxed mt-1">{masterOutlineText.slice(0, 160)}{masterOutlineText.length > 160 ? '…' : ''}</p>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Progress / error */}
      {run.phase !== 'idle' && (
        <div className={cn(
          'mx-5 mb-1 px-3 py-2 rounded-lg text-xs flex items-center gap-2 flex-shrink-0',
          run.phase === 'error' ? 'bg-red-500/10 border border-red-500/25 text-red-400' : 'bg-violet-500/10 border border-violet-500/25 text-violet-300',
        )}>
          {run.phase === 'running' && <Loader2 size={12} className="animate-spin flex-shrink-0" />}
          <span className="truncate">{run.message}</span>
          {run.phase === 'running' && (
            <button onClick={cancelRun} className="ml-auto flex items-center gap-1 px-2 h-6 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 text-[11px] flex-shrink-0 transition-colors">
              <Square size={9} /> 停止
            </button>
          )}
          {run.phase === 'error' && (
            <button onClick={() => setRun({ phase: 'idle', message: '' })} className="ml-auto px-2 h-6 rounded-md bg-red-500/15 text-red-300 hover:bg-red-500/25 text-[11px] flex-shrink-0 transition-colors">
              关闭
            </button>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-t border-border/40 flex-shrink-0">
        {step === 1 && (
          <button onClick={runSeed} disabled={run.phase === 'running'} className="h-8 px-3 rounded-lg bg-violet-500/15 border border-violet-500/30 text-xs text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 transition-colors flex items-center gap-1.5">
            <Wand2 size={11} />
            {proposal ? '换一批提案' : 'AI 补全提案'}
          </button>
        )}
        {step === 2 && masterPlan && (
          <button onClick={runMaster} disabled={run.phase === 'running'} className="h-8 px-3 rounded-lg bg-violet-500/15 border border-violet-500/30 text-xs text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 transition-colors flex items-center gap-1.5">
            <Wand2 size={11} /> 换一批
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {step > 1 && step < 4 && (
            <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)} disabled={run.phase === 'running'}>
              上一步
            </Button>
          )}
          {step < 4 && (
            <Button size="sm" onClick={() => setStep(step + 1)} disabled={!canNext || run.phase === 'running'}>
              {step === 3 ? '下一步：确认落库' : '下一步'}
              <ChevronRight size={12} className="ml-0.5" />
            </Button>
          )}
          {step === 4 && !applied && (
            <Button size="sm" onClick={runApply} disabled={run.phase === 'running'}>
              确认落库
            </Button>
          )}
          {step === 4 && applied && (
            <Button size="sm" onClick={() => { onApplied(); onClose() }}>
              完成
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
