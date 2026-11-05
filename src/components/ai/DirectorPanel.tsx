import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Play,
  RotateCw,
  StopCircle,
  Loader2,
  Check,
  AlertCircle,
  UserCheck,
  Hand,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { AGENT_ROLE_LABELS } from '@shared/constants'
import type { AgentConfig, LiberationLevel, DirectorTask } from '@shared/types'
import {
  createDirectorTask,
  runDirector,
  resumeDirector,
  buildResumeTask,
  type DirectorProgress,
} from '@/services/director-service'
import { loadCheckpoints } from '@/services/tracking-service'
import { pickAgentForRole } from '@/services/agent-service'
import { useSettingsStore } from '@/stores'
import { Button } from '@/components/ui/button'
import RoleLedgerPanel from '@/components/workbench/RoleLedgerPanel'

const LEVELS: { level: LiberationLevel; name: string; desc: string }[] = [
  { level: 'L1', name: 'L1 全程主导', desc: '每步均需作者逐项审批' },
  { level: 'L2', name: 'L2 协同', desc: '关键节点（大纲/黄金三章）审批' },
  { level: 'L3', name: 'L3 半自动', desc: '仅大纲定稿+黄金三章审批' },
  { level: 'L4', name: 'L4 全自动驾驶', desc: '仅卷末 review 审批' },
]

interface StageState {
  id: string
  agentRole: AgentConfig['role']
  label: string
  status: 'pending' | 'running' | 'completed' | 'awaiting-approval' | 'error'
  output?: string
  error?: string
  approvalReason?: string
}

export default function DirectorPanel({ novelId }: { novelId: string }) {
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)
  const [intent, setIntent] = useState('')
  const [level, setLevel] = useState<LiberationLevel>('L4')
  const [stages, setStages] = useState<StageState[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [hasCheckpoints, setHasCheckpoints] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<{ subtaskId: string; reason: string } | null>(null)
  const [taskStatus, setTaskStatus] = useState<'idle' | 'running' | 'paused' | 'completed'>('idle')

  const taskRef = useRef<DirectorTask | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const ledgerRefreshRef = useRef<(() => void) | null>(null)

  // D-T4-2：按角色选取时优先取已配 key 的行（种子行与用户行并存场景）
  const allAgentsConfigured = agentConfigs.length > 0 &&
    ['architect', 'writer', 'polisher', 'checker', 'runtime', 'director'].every((role) =>
      !!pickAgentForRole(agentConfigs, role)?.apiKeyEncrypted
    )

  // D-T7-3：依赖 taskStatus 做响应式刷新——运行中产生的 checkpoint 在任务暂停/完成后立即可见，
  // 不再只在挂载时判定一次
  useEffect(() => {
    loadCheckpoints(novelId).then((c) => setHasCheckpoints(c.length > 0)).catch(() => setHasCheckpoints(false))
  }, [novelId, taskStatus])

  const buildOptions = useCallback(
    () => ({
      novelId,
      previousMessages: [] as { role: string; content: string }[],
    }),
    [novelId]
  )

  const applyProgress = useCallback((p: DirectorProgress) => {
    setStages((prev) => {
      const next = [...prev]
      const idx = p.stageIndex
      if (idx < 0 || idx >= next.length) return prev
      const s = { ...next[idx] }
      if (p.status === 'running') s.status = 'running'
      else if (p.status === 'completed') {
        s.status = 'completed'
        s.output = p.output
      } else if (p.status === 'awaiting-approval') {
        s.status = 'awaiting-approval'
        s.approvalReason = p.approvalRequest?.reason
      } else if (p.status === 'error') {
        s.status = 'error'
        s.error = p.output
      }
      next[idx] = s
      return next
    })
  }, [])

  const consume = useCallback(
    async (gen: AsyncGenerator<DirectorProgress>) => {
      setIsRunning(true)
      setTaskStatus('running')
      try {
        for await (const p of gen) {
          applyProgress(p)
          if (p.status === 'awaiting-approval') {
            setPendingApproval({ subtaskId: p.approvalRequest!.subtaskId, reason: p.approvalRequest!.reason })
            setTaskStatus('paused')
            setIsRunning(false)
            return
          }
          if (p.status === 'error') {
            setIsRunning(false)
            setTaskStatus('paused')
            return
          }
        }
        setTaskStatus('completed')
        setIsRunning(false)
        ledgerRefreshRef.current?.()
      } catch (err: any) {
        if (err.name !== 'AbortError') console.error('[DirectorPanel] run failed', err)
        setIsRunning(false)
        setTaskStatus('paused')
      }
    },
    [applyProgress]
  )

  const start = useCallback(async () => {
    if (!intent.trim() || !allAgentsConfigured) return
    const task = createDirectorTask(novelId, intent.trim(), level)
    taskRef.current = task
    const initial: StageState[] = task.decomposed.map((s) => ({
      id: s.id,
      agentRole: s.agentRole,
      label: s.input.slice(0, 28),
      status: 'pending',
    }))
    setStages(initial)
    setPendingApproval(null)
    const agents = agentConfigs as AgentConfig[]
    const abort = new AbortController()
    abortRef.current = abort
    await consume(runDirector(task, agents, novelId, buildOptions(), abort.signal))
  }, [intent, level, novelId, allAgentsConfigured, agentConfigs, buildOptions, consume])

  const resume = useCallback(async () => {
    const task = await buildResumeTask(novelId, level)
    if (!task) return
    taskRef.current = task
    // 复用已有阶段状态（若有），否则从计划重建
    if (stages.length === 0) {
      setStages(task.decomposed.map((s) => ({
        id: s.id,
        agentRole: s.agentRole,
        label: s.input.slice(0, 28),
        status: 'pending',
      })))
    }
    setPendingApproval(null)
    const agents = agentConfigs as AgentConfig[]
    const abort = new AbortController()
    abortRef.current = abort
    await consume(resumeDirector(task, agents, novelId, buildOptions(), abort.signal))
  }, [novelId, level, stages.length, agentConfigs, buildOptions, consume])

  const approveAndContinue = useCallback(async () => {
    const task = taskRef.current
    if (!task || !pendingApproval) return
    const st = task.decomposed.find((s) => s.id === pendingApproval.subtaskId)
    if (st) st.autoApprove = true
    setPendingApproval(null)
    setStages((prev) =>
      prev.map((s) => (s.id === pendingApproval.subtaskId ? { ...s, status: 'running', approvalReason: undefined } : s))
    )
    const agents = agentConfigs as AgentConfig[]
    const abort = new AbortController()
    abortRef.current = abort
    await consume(resumeDirector(task, agents, novelId, buildOptions(), abort.signal))
  }, [pendingApproval, agentConfigs, novelId, buildOptions, consume])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsRunning(false)
    setTaskStatus('paused')
  }, [])

  // D-T7-1：暂停态区分「待审批 / 出错 / 已暂停」，不再一律显示「已暂停 / 待审批」
  const hasStageError = stages.some((s) => s.status === 'error')
  const statusBadge = {
    idle: { text: '待命', cls: 'text-muted-foreground' },
    running: { text: '自动驾驶中', cls: 'text-primary' },
    paused: {
      text: pendingApproval ? '待审批' : hasStageError ? '已暂停 · 出错' : '已暂停',
      cls: pendingApproval ? 'text-amber-400' : hasStageError ? 'text-red-400' : 'text-amber-400',
    },
    completed: { text: '已完成', cls: 'text-emerald-400' },
  }[taskStatus]

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-4 overflow-y-auto flex-1">
        {/* 意图输入 */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">创作意图（一句话灵感）</label>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={isRunning}
            placeholder="例：写一部东方玄幻，主角是个被家族遗弃的少年，靠一本残破古卷逆袭"
            className="w-full h-20 px-3 py-2 text-xs rounded-lg bg-muted/30 border border-border/40 text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-primary/50"
          />
        </div>

        {/* 解放度选择 */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">作者解放度（审批分级）</label>
          <div className="grid grid-cols-2 gap-1.5">
            {LEVELS.map((lv) => (
              <button
                key={lv.level}
                onClick={() => !isRunning && setLevel(lv.level)}
                className={cn(
                  'p-2 rounded-lg border text-left transition-all',
                  level === lv.level
                    ? 'bg-primary/10 border-primary/40 text-foreground'
                    : 'bg-muted/20 border-transparent text-muted-foreground hover:border-border/40',
                  isRunning && 'opacity-50 cursor-not-allowed'
                )}
              >
                <div className="text-xs font-medium">{lv.name}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{lv.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 操作区 */}
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button size="sm" variant="ghost" onClick={handleStop} className="text-red-400 hover:text-red-300">
              <StopCircle size={12} className="mr-1" /> 停止
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={start} disabled={!intent.trim() || !allAgentsConfigured}>
                <Play size={12} className="mr-1" /> 开始导演
              </Button>
              {hasCheckpoints && taskStatus !== 'running' && (
                <Button size="sm" variant="outline" onClick={resume}>
                  <RotateCw size={12} className="mr-1" /> 从检查点续跑
                </Button>
              )}
            </>
          )}
          <span className={cn('text-[11px] ml-auto flex items-center gap-1', statusBadge.cls)}>
            {isRunning && <Loader2 size={11} className="animate-spin" />}
            {statusBadge.text}
          </span>
        </div>

        {/* 子任务链 */}
        {stages.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
              <Sparkles size={12} className="text-primary" /> 子任务执行链
            </div>
            {stages.map((stage, i) => {
              const role = AGENT_ROLE_LABELS[stage.agentRole]
              const statusIcon =
                stage.status === 'completed' ? <Check size={12} className="text-emerald-400" />
                : stage.status === 'running' ? <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
                : stage.status === 'awaiting-approval' ? <UserCheck size={12} className="text-amber-400" />
                : stage.status === 'error' ? <AlertCircle size={12} className="text-red-400" />
                : <div className="w-2.5 h-2.5 rounded-full bg-border" />
              return (
                <div
                  key={stage.id}
                  className={cn(
                    'p-2.5 rounded-lg border',
                    stage.status === 'awaiting-approval'
                      ? 'bg-amber-500/10 border-amber-500/30'
                      : stage.status === 'error'
                      ? 'bg-red-500/10 border-red-500/30'
                      : 'bg-white/5 border-white/10'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{role?.emoji ?? '🤖'}</span>
                    <span className="text-xs font-medium text-foreground">{role?.name ?? stage.agentRole}</span>
                    <span className="text-[10px] text-muted-foreground truncate flex-1">{stage.label}</span>
                    {statusIcon}
                  </div>
                  {stage.output && stage.status === 'completed' && (
                    <p className="mt-1.5 text-[10px] text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                      {stage.output}
                    </p>
                  )}
                  {stage.error && (
                    <p className="mt-1.5 text-[10px] text-red-400">{stage.error}</p>
                  )}

                  {/* 审批卡（三态：待审批） */}
                  {stage.status === 'awaiting-approval' && (
                    <div className="mt-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-center gap-1 text-[11px] text-amber-300">
                        <UserCheck size={11} /> 待作者审批
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{stage.approvalReason}</p>
                      <div className="flex gap-1.5 mt-2">
                        <Button size="sm" variant="outline" onClick={approveAndContinue} className="text-[10px] h-6">
                          <UserCheck size={10} className="mr-1" /> 批准继续
                        </Button>
                        <Button size="sm" variant="ghost" onClick={handleStop} className="text-[10px] h-6 text-muted-foreground">
                          <Hand size={10} className="mr-1" /> 接管
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!allAgentsConfigured && !isRunning && (
          <div className="p-2.5 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-[11px] text-yellow-400">
            <AlertCircle size={12} className="inline mr-1" />
            部分 Agent 的 API Key 尚未配置，请前往设置页面完成配置
          </div>
        )}

        {/* 角色资源账本 */}
        <div className="pt-2 border-t border-white/10">
          <RoleLedgerPanel
            novelId={novelId}
            onReady={(fn) => (ledgerRefreshRef.current = fn)}
          />
        </div>
      </div>
    </div>
  )
}
