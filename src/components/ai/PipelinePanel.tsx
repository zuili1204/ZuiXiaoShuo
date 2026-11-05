import { useState, useRef, useCallback, useEffect } from 'react'
import { Play, RotateCw, Check, AlertCircle, ArrowRight, StopCircle, Loader2, Save, ListTree } from 'lucide-react'
import { useSettingsStore, useWorkbenchStore } from '@/stores'
import { cn } from '@/utils/cn'
import { classifyError } from '@/utils/error-handler'
import { AGENT_ROLE_LABELS } from '@shared/constants'
import { runPipeline, pickAgentForRole, type PipelineProgress } from '@/services/agent-service'
import { ensureStoryMemory } from '@/services/kb-auto-build'
import { chapterService } from '@/services/data-service'
import { createSnapshot } from '@/services/snapshot-service'
import { extractPolishedBody } from '@/utils/polish-output'
import { checkAnchors } from '@/utils/anchor-check'
import { listSceneCards, updateSceneCard, computeHooksCoverage } from '@/services/scene-service'
import { insertSceneMarkersAtParagraphs, stripSceneMarkers } from '@shared/scene-marker'
import { Button } from '@/components/ui/button'
import type { AgentConfig, SceneCard } from '@shared/types'

interface PipelineStageState {
  agentRole: AgentConfig['role']
  label: string
  status: 'pending' | 'running' | 'completed' | 'error' | 'pending-approval'
  output?: string
  error?: string
}

const PRESET_PIPELINES = [
  {
    name: '完整流水线',
    // 2026-10-05 事故修复：architect 必须先于 writer——旧顺序 writer 先行，
    // writer 拿不到细纲规划直接自由发挥（先写后规划 = 没有大纲）
    description: '架构→写作→润色→终审',
    stages: ['architect', 'writer', 'polisher', 'checker'] as AgentConfig['role'][],
  },
  {
    name: '快速模式',
    description: '架构→写作',
    stages: ['architect', 'writer'] as AgentConfig['role'][],
  },
  {
    name: '仅润色',
    description: '润色→检查',
    stages: ['polisher', 'checker'] as AgentConfig['role'][],
  },
]

export default function PipelinePanel({ novelId }: { novelId: string }) {
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)
  const editorContent = useWorkbenchStore((s) => s.editorContent)
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const setEditorContent = useWorkbenchStore((s) => s.setEditorContent)
  const setDirty = useWorkbenchStore((s) => s.setDirty)
  const reloadEditor = useWorkbenchStore((s) => s.reloadEditor)
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)
  const setEditorDrawer = useWorkbenchStore((s) => s.setEditorDrawer)

  const [selectedPreset, setSelectedPreset] = useState(0)
  const [sceneCards, setSceneCards] = useState<SceneCard[]>([])
  // 流水线是长任务，回写时读取 ref 里的最新场景卡（state 闭包会停留在启动时的快照）
  const sceneCardsRef = useRef<SceneCard[]>([])
  const [stages, setStages] = useState<PipelineStageState[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [fullOutput, setFullOutput] = useState('')
  const [savingStage, setSavingStage] = useState<number | null>(null)
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const getAgent = useCallback((role: AgentConfig['role']) => {
    // D-T4-2：同角色并存空 key 种子行与用户行时，优先选已配 key 的
    return pickAgentForRole(agentConfigs, role)
  }, [agentConfigs])

  const allAgentsConfigured = PRESET_PIPELINES[selectedPreset].stages.every(
    (role) => getAgent(role)?.apiKeyEncrypted
  )

  useEffect(() => {
    let cancelled = false
    if (!selectedChapter) {
      sceneCardsRef.current = []
      setSceneCards([])
      return
    }
    listSceneCards(selectedChapter.id)
      .then((cards) => {
        if (cancelled) return
        sceneCardsRef.current = cards
        setSceneCards(cards)
      })
      .catch(() => { if (!cancelled) setSceneCards([]) })
    return () => { cancelled = true }
  }, [selectedChapter?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const sceneCoverage = computeHooksCoverage(sceneCards, selectedChapter?.hooks ?? [])
  const showSceneWarning =
    !!selectedChapter?.hooks?.length &&
    (sceneCards.length === 0 || sceneCoverage.uncovered.length > 0)

  const startPipeline = async (presetIdx: number) => {
    const preset = PRESET_PIPELINES[presetIdx]
    setSelectedPreset(presetIdx)

    // Build stage agents list
    const stageAgents: { agent: AgentConfig; label: string }[] = []
    for (const role of preset.stages) {
      const agent = getAgent(role)
      if (!agent) {
        // Can't run if any agent is missing
        setStages(preset.stages.map((r) => ({
          agentRole: r,
          label: AGENT_ROLE_LABELS[r].name,
          status: 'error' as const,
          error: `Agent "${AGENT_ROLE_LABELS[r].name}" 未配置`,
        })))
        return
      }
      if (!agent.apiKeyEncrypted) {
        setStages(preset.stages.map((r) => ({
          agentRole: r,
          label: AGENT_ROLE_LABELS[r].name,
          status: 'error' as const,
          error: `Agent "${AGENT_ROLE_LABELS[r].name}" 的 API Key 未设置`,
        })))
        return
      }
      stageAgents.push({ agent, label: AGENT_ROLE_LABELS[role].name })
    }

    // Initialize stages
    const initialStages: PipelineStageState[] = preset.stages.map((role) => ({
      agentRole: role,
      label: AGENT_ROLE_LABELS[role].name,
      status: 'pending',
    }))
    setStages(initialStages)
    setFullOutput('')
    setIsRunning(true)

    // 启动前刷新场景卡，保证产出入库后的标记/状态基于最新施工图
    if (selectedChapter) {
      try {
        const latestCards = await listSceneCards(selectedChapter.id)
        sceneCardsRef.current = latestCards
        setSceneCards(latestCards)
      } catch {
        /* 读取失败不阻断流水线，仅失去场景标记回写 */
      }
    }

    const abortController = new AbortController()
    abortRef.current = abortController

    try {
      // 含 writer 阶段 = 生成模式：编辑器里的章节旧稿只是「将被覆盖的草稿」，
      // 不能当作 writer 的任务指令，也不得进入上下文（实测事故：旧稿被逐字复述且绕过前情衔接）。
      // 仅润色等无 writer 的流水线 = 处理模式：编辑器内容就是待处理文本。
      const isGenerationPreset = preset.stages.includes('writer')
      const hasExistingBody = (selectedChapter?.wordCount ?? 0) > 0
      const editorText = editorContent?.trim() ?? ''
      const hasHooks = !!selectedChapter?.hooks?.length

      // 无细纲不生成（2026-10-05）：细纲是 writer 的锚点合约，没有细纲 = AI 无目的自由发挥。
      // 空白章允许用编辑器文字作为作者补充要求替代；两者皆无则拒绝启动
      if (isGenerationPreset && !hasHooks && !(!hasExistingBody && editorText)) {
        setSaveMessage({
          type: 'error',
          text: `第${selectedChapter?.order ?? '?'}章没有细纲(hooks)，也没有作者补充要求。请先在大纲面板为本章生成/填写细纲，或在空白章编辑器中写下本章要求后再启动流水线。`,
        })
        setTimeout(() => setSaveMessage(null), 8000)
        return
      }

      const options = {
        novelId,
        chapterId: selectedChapter?.id,
        chapterContent: isGenerationPreset ? undefined : editorContent,
        excludeCurrentChapterContent: isGenerationPreset,
        chapterSummary: selectedChapter?.summary || '',
        previousMessages: [],
      }

      const hooksText = hasHooks
        ? `本章细纲（最高优先级锚点合约，正文必须逐条覆盖，不得擅自更改事实走向）：\n${selectedChapter!.hooks!.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : ''

      const userInput = isGenerationPreset
        ? [
            selectedChapter
              ? `请为本书撰写第${selectedChapter.order}章《${selectedChapter.title}》的完整正文。`
              : '请为本书撰写当前章节的完整正文。',
            hooksText,
            hasExistingBody ? '（本章为重新生成，将覆盖旧稿；旧稿仅供参考剧情走向，严禁逐字复述。）' : '',
            !hasExistingBody && editorText ? `作者补充要求：\n${editorText.slice(0, 2000)}` : '',
            '直接输出小说正文，不要输出报告、说明或元信息。',
          ]
            .filter(Boolean)
            .join('\n')
        : editorContent || '请根据当前章节内容进行处理'

      let accumulatedOutput = ''
      const finalOutputs: (string | undefined)[] = []

      // 续写前剧情记忆保障：本书存在「有正文无摘要」的章节（导入书/旧书）时，
      // 先自动构建知识库补齐前情，再进入流水线，避免生成器剧情漂移
      for await (const p of ensureStoryMemory(novelId, abortController.signal)) {
        const label =
          p.phase === 'chapter'
            ? `正在总结 ${p.index + 1}/${p.total}《${p.title ?? ''}》${p.message ?? ''}`
            : p.message ?? ''
        setFullOutput(`[剧情记忆] ${label}`)
      }
      if (abortController.signal.aborted) return
      setFullOutput('')

      for await (const progress of runPipeline(stageAgents, userInput, options, abortController.signal)) {
        setStages((prev) =>
          prev.map((s, i) => {
            if (i === progress.stageIndex) {
              if (progress.status === 'running') return { ...s, status: 'running' }
              if (progress.status === 'completed') return { ...s, status: 'completed', output: progress.output }
              if (progress.status === 'pending-approval') {
                const continuity = progress.continuityFindings?.filter((f) => f.severity === 'blocking') ?? []
                const error = progress.quality?.report
                  || (continuity.length ? `连贯性检查未通过：${continuity.map((f) => f.message).join('；')}` : '质量门禁未通过，已拦截下发')
                return { ...s, status: 'pending-approval', error }
              }
              if (progress.status === 'error') return { ...s, status: 'error', error: classifyError(progress.error).message }
            }
            return s
          })
        )

        if (progress.status === 'completed' && progress.output) {
          finalOutputs[progress.stageIndex] = progress.output
          accumulatedOutput += progress.output + '\n\n'
          setFullOutput(accumulatedOutput)
        }

        if (progress.status === 'error') {
          break
        }
      }

      // 流水线全部完成后，自动保存最终正文产出到当前章节
      const allCompleted = stageAgents.every((_, i) => finalOutputs[i])
      if (allCompleted && selectedChapter && !abortController.signal.aborted) {
        // 优先取最后一个正文阶段（writer/polisher）的产出作为最终正文，
        // 避免把审稿意见/检查报告误存为正文
        let bestOutput = ''
        let bestLabel = ''
        for (let i = finalOutputs.length - 1; i >= 0; i--) {
          const role = stageAgents[i]?.agent.role
          if (finalOutputs[i] && (role === 'writer' || role === 'polisher')) {
            bestOutput = finalOutputs[i]!
            bestLabel = stageAgents[i]?.label || ''
            break
          }
        }
        if (bestOutput.trim()) {
          // 自动保存最终正文（含产出首行「第N章 · 标题」的标题剥离与章节树同步）
          await applyOutputToChapter(bestOutput, bestLabel)
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Pipeline was cancelled
        setStages((prev) =>
          prev.map((s) =>
            s.status === 'running' ? { ...s, status: 'error', error: '已取消' } : s
          )
        )
      } else {
        console.error('Pipeline error:', err)
        const classified = classifyError(err)
        setStages((prev) =>
          prev.map((s) =>
            s.status === 'running' ? { ...s, status: 'error', error: classified.message } : s
          )
        )
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }

  /**
   * 产出首行若为「第N章 · 标题」形式的标题行，则剥离为章节标题、其余作为正文保存。
   * 解决：流水线回写正文后章节树标题停留在「第5章」占位（观察项）。
   * 仅当首行带非空副标题时才提取（纯「第5章」行无信息量，保留在正文内不动）。
   */
  const applyOutputToChapter = async (output: string, label: string) => {
    if (!selectedChapter) return
    // 守门：润色阶段产出是「报告 + 全文」协议，直接入库会把报告当正文（2026-10-05 实测事故）；
    // 提取失败（截断/过短/残留）一律拒写。
    const extracted = extractPolishedBody(output)
    if (!extracted) {
      setSaveMessage({
        type: 'error',
        text: `「${label}」产出未包含可用正文（疑似润色报告、内容被截断或过短），已阻止写入章节。可在阶段卡片中查看原始产出。`,
      })
      setTimeout(() => setSaveMessage(null), 6000)
      return
    }
    let title: string | undefined
    let content = extracted.text
    const lineEnd = content.indexOf('\n')
    const firstLine = (lineEnd === -1 ? content : content.slice(0, lineEnd)).trim()
    const m = firstLine.match(/^#{0,6}\s*(第\s*[0-9零一二三四五六七八九十百千两]+\s*章)\s*[·:：．\-—]?\s*(\S[^\n]{0,30})$/)
    if (m) {
      title = `${m[1].replace(/\s+/g, '')} ${m[2].trim()}`
      content = content.slice(lineEnd === -1 ? content.length : lineEnd + 1).replace(/^\s*\n/, '')
    }
    // 整章生成会丢掉场景边界：按当前施工图重新切分，保证后续仍可逐场重写
    const activeCards = sceneCardsRef.current.filter((c) => c.status !== 'cut')
    let finalContent = content
    if (activeCards.length) {
      finalContent = insertSceneMarkersAtParagraphs(
        stripSceneMarkers(content),
        activeCards.map((c) => c.id),
      )
    }
    try {
      // 硬锚点校验（仅提示不拦截）：hooks 是写作合约，正文漏锚点时警告作者人工复核
      let anchorWarning = ''
      if (selectedChapter.hooks?.length) {
        const { missed } = checkAnchors(content, selectedChapter.hooks)
        if (missed.length) {
          anchorWarning = `⚠️ ${missed.length} 条细纲锚点未在正文中命中，请人工复核：${missed.slice(0, 3).join('；')}${missed.length > 3 ? ' 等' : ''}`
          console.warn('[anchor-check] missed anchors:', missed)
        }
      }
      await chapterService.saveContent(selectedChapter.id, finalContent, { source: 'pipeline', novelId })
      let displayTitle = selectedChapter.title
      if (title && title !== selectedChapter.title) {
        await chapterService.update(selectedChapter.id, { title })
        displayTitle = title
        // 更新 store 选中章节 → 章节树的同步 effect 会随之刷新标题显示
        selectChapter({ ...selectedChapter, title })
      }
      setEditorContent(finalContent)
      setDirty(false)
      reloadEditor()
      // 场景卡状态与新正文对齐（整章生成视为所有有效场景均已写）
      if (activeCards.length) {
        for (const c of activeCards) {
          updateSceneCard(c.id, { status: 'written' }).catch(() => {})
        }
        setSceneCards((prev) => prev.map((c) => (c.status === 'cut' ? c : { ...c, status: 'written' })))
      }
      // 流水线回写正文：关键节点强制快照
      createSnapshot(selectedChapter.id, 'pipeline').catch(() => {})
      setSaveMessage({
        type: anchorWarning ? 'info' : 'success',
        text: anchorWarning || `已保存「${label}」产出到章节《${displayTitle}》`,
      })
      setTimeout(() => setSaveMessage(null), 4500)
    } catch (e: any) {
      setSaveMessage({ type: 'error', text: `保存失败: ${e?.message || String(e)}` })
      setTimeout(() => setSaveMessage(null), 5000)
    }
  }

  /**
   * 将指定 stage（默认最后一个 completed stage）的产出写入当前章节正文。
   * @param stageIndex 可选：stages 原始数组中的索引；不传则取最后一个 completed stage。
   */
  const handleSaveToChapter = async (stageIndex?: number) => {
    if (savingStage !== null) return
    if (!selectedChapter) {
      setSaveMessage({ type: 'info', text: '请先在左侧选择一个章节' })
      setTimeout(() => setSaveMessage(null), 3000)
      return
    }
    // 确定要保存的产出
    let output = ''
    let targetLabel = ''
    if (stageIndex !== undefined && stages[stageIndex]?.output) {
      output = stages[stageIndex].output
      targetLabel = stages[stageIndex].label
    } else {
      for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i]
        if (s.status === 'completed' && s.output) {
          output = s.output
          targetLabel = s.label
          break
        }
      }
    }
    if (!output.trim()) {
      setSaveMessage({ type: 'info', text: '暂无可保存的产出' })
      setTimeout(() => setSaveMessage(null), 3000)
      return
    }
    setSavingStage(stageIndex ?? -1)
    setSaveMessage(null)
    try {
      await applyOutputToChapter(output, targetLabel)
    } finally {
      setSavingStage(null)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Agent 流水线</h3>
        <div className="flex items-center gap-1">
          {isRunning ? (
            <Button size="sm" variant="ghost" onClick={handleStop} className="text-red-400 hover:text-red-300">
              <StopCircle size={12} className="mr-1" />
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => startPipeline(selectedPreset)}
              disabled={!allAgentsConfigured}
            >
              <Play size={12} className="mr-1" />
              执行
            </Button>
          )}
        </div>
      </div>

      {/* Presets */}
      <div className="flex gap-1.5">
        {PRESET_PIPELINES.map((preset, i) => (
          <button
            key={i}
            onClick={() => !isRunning && setSelectedPreset(i)}
            className={cn(
              'flex-1 p-2 rounded-lg text-center transition-all border',
              selectedPreset === i
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'bg-muted/20 text-muted-foreground border-transparent hover:border-border/40',
              isRunning && 'opacity-50 cursor-not-allowed'
            )}
          >
            <div className="text-xs font-medium">{preset.name}</div>
            <div className="text-[10px] opacity-60 mt-0.5">{preset.description}</div>
          </button>
        ))}
      </div>

      {/* 场景卡覆盖预检：不阻断启动，但提示可能漏写的细纲 */}
      {showSceneWarning && !isRunning && (
        <div className="p-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-400">
          <div className="flex items-start gap-1.5">
            <ListTree size={12} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1 leading-relaxed">
              {sceneCards.length === 0
                ? '本章还没有场景卡，细纲尚未拆成可执行的施工图。'
                : `场景卡覆盖细纲 ${sceneCoverage.covered}/${sceneCoverage.total}，未覆盖：${sceneCoverage.uncovered.join('、')}。`}
              <button
                onClick={() => setEditorDrawer('scenes')}
                className="ml-1 underline hover:text-amber-300 transition-colors"
              >
                打开场景卡
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pipeline visualization */}
      {stages.length > 0 && (
        <div className="space-y-2">
          {/* Stage flow */}
          <div className="flex items-center gap-2 justify-center">
            {stages.map((stage, i) => {
              const agent = getAgent(stage.agentRole)
              const statusIcon = stage.status === 'completed'
                ? <Check size={11} className="text-green-400" />
                : stage.status === 'running'
                  ? <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
                  : stage.status === 'error'
                    ? <AlertCircle size={11} className="text-red-400" />
                    : <div className="w-2.5 h-2.5 rounded-full bg-border" />

              return (
                <div key={i} className="flex items-center gap-2">
                  <div className={cn(
                    'flex flex-col items-center gap-0.5',
                    stage.status === 'completed' ? 'opacity-60' : ''
                  )}>
                    <span className="text-lg">{AGENT_ROLE_LABELS[stage.agentRole].emoji}</span>
                    <span className="text-[9px] text-muted-foreground whitespace-nowrap">{stage.label}</span>
                    {statusIcon}
                  </div>
                  {i < stages.length - 1 && (
                    <ArrowRight size={12} className={cn(
                      'text-muted-foreground/40',
                      stage.status === 'completed' && 'text-primary/50'
                    )} />
                  )}
                </div>
              )
            })}
          </div>

          {/* Stage outputs */}
          {stages.some(s => s.status === 'completed' || s.status === 'error') && (
            <div className="space-y-1.5 mt-3">
              {stages.filter(s => s.output || s.error).map((stage, i) => {
                const origIdx = stages.indexOf(stage)
                return (
                  <div
                    key={i}
                    className={cn(
                      'p-2 rounded-md text-xs',
                      stage.status === 'error'
                        ? 'bg-red-500/10 text-red-400'
                        : 'bg-muted/30 text-muted-foreground'
                    )}
                  >
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="font-medium flex-shrink-0">{stage.label}</span>
                      {stage.status === 'completed' && stage.output && selectedChapter && (
                        <button
                          onClick={() => handleSaveToChapter(origIdx)}
                          disabled={savingStage !== null}
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 text-[10px] hover:bg-green-500/25 disabled:opacity-40 flex-shrink-0"
                          title="将该阶段产出写入当前章节正文"
                        >
                          <Save size={9} />
                          {savingStage === origIdx ? '保存中…' : '应用此版本'}
                        </button>
                      )}
                    </div>
                    <div className="whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                      {stage.status === 'error' ? stage.error : stage.output}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Agent missing warnings */}
          {!allAgentsConfigured && !isRunning && (
            <div className="p-2 rounded-md bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-400">
              <AlertCircle size={12} className="inline mr-1" />
              部分 Agent 的 API Key 尚未配置，请前往设置页面完成配置
            </div>
          )}

          {/* 最终保存到当前章节（流水线全部完成时） */}
          {!isRunning && stages.length > 0 && stages.every(s => s.status === 'completed') && selectedChapter && (
            <div className="mt-3 p-2.5 rounded-md bg-green-500/5 border border-green-500/20 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs text-green-400 font-medium">流水线执行完成</div>
                <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                  将最终阶段（{stages[stages.length - 1]?.label}）产出写入「{selectedChapter.title}」
                </div>
              </div>
              <button
                onClick={() => handleSaveToChapter()}
                disabled={savingStage !== null}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-green-500/20 text-green-400 text-xs hover:bg-green-500/30 disabled:opacity-40 flex-shrink-0"
              >
                <Save size={11} />
                {savingStage !== null ? '保存中…' : '保存到当前章节'}
              </button>
            </div>
          )}

          {/* 保存结果提示 */}
          {saveMessage && !isRunning && (
            <div className={cn(
              'mt-2 p-2 rounded-md text-xs',
              saveMessage.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : saveMessage.type === 'error' ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
            )}>
              {saveMessage.text}
            </div>
          )}
        </div>
      )}

      {/* Placeholder when no stages */}
      {stages.length === 0 && (
        <div className="py-8 text-center">
          <div className="text-xs text-muted-foreground mb-3">
            选择预设流水线并点击执行，Agent 将按顺序依次处理
          </div>
          {allAgentsConfigured ? (
            <Button size="sm" variant="outline" onClick={() => startPipeline(0)}>
              <Play size={12} className="mr-1.5" />
              执行完整流水线
            </Button>
          ) : (
            <div className="text-xs text-yellow-400">
              <AlertCircle size={12} className="inline mr-1" />
              请先配置 Agent API Key
            </div>
          )}
        </div>
      )}

      {/* Running indicator */}
      {isRunning && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" />
          流水线执行中...
        </div>
      )}
    </div>
  )
}
