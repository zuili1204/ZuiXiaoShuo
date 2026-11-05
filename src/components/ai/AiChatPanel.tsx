import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Send, Bot, User, Loader2, ChevronDown, Zap, Sparkles, FileSearch, PenLine, StopCircle, Trash2, Copy, Check, Wrench, MessageSquare, ChevronRight, Brain } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useSettingsStore, useWorkbenchStore } from '@/stores'
import { agentChat, pickAgentForRole } from '@/services/agent-service'
import { supportsTools } from '@/services/llm-service'
import { ensureStoryMemory } from '@/services/kb-auto-build'
import { chatService, chapterService } from '@/services/data-service'
import { ActionLog } from '@/services/log-service'
import { classifyError, getFallbackProvider, type ClassifiedError } from '@/utils/error-handler'
import { ErrorCard } from '@/components/ui/ErrorCard'
import { LLM_PROVIDERS } from '@shared/constants'
import type { AgentConfig, AgentLoopEvent, BuildContextOptions, AgentMode } from '@shared/types'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  error?: ClassifiedError
  thinking?: string // 思考链内容
}

type ChatMode = 'ask' | 'writing' | 'craft'

const AGENTS = [
  { id: 'architect', name: '审稿者', emoji: '🏗️', color: 'text-blue-400' },
  { id: 'writer', name: '作者', emoji: '✍️', color: 'text-green-400' },
  { id: 'polisher', name: '润稿者', emoji: '✨', color: 'text-purple-400' },
  { id: 'checker', name: '读者', emoji: '🔍', color: 'text-orange-400' },
]

const QUICK_COMMANDS = [
  { icon: FileSearch, label: '/审查', hint: '分析本章结构' },
  { icon: Sparkles, label: '/去AI', hint: '去除AI味' },
  { icon: PenLine, label: '/续写', hint: '续写本章' },
  { icon: Zap, label: '/润色', hint: '润色文笔' },
]

function getDefaultWelcome(agentName: string): ChatMessage {
  return {
    id: 'welcome',
    role: 'assistant',
    content: `你好！我是**${agentName}**。我可以帮你分析章节结构、诊断节奏问题、设计钩子和伏笔。你可以直接粘贴章节内容，或者描述当前遇到的写作困惑，我会给出专业建议。\n\n💡 切换底部 **[craft]** 模式可让我直接修改原文（逐句建议 + accept/reject）。`,
    timestamp: Date.now(),
  }
}

// 将任意值安全归一化为字符串
const normalizeInput = (raw: unknown): string => {
  if (typeof raw === 'string') return raw.trim()
  if (raw == null) return ''
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    for (const key of ['content', 'text', 'message', 'value', 'label']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key].trim()
    }
    console.warn('AiChatPanel: discarded non-serializable input:', raw)
  }
  return ''
}

// 尝试从 AI 响应中解析结构化编辑建议 JSON
function parseEditSuggestions(text: string): import('@/stores/workbench-store').EditSuggestion[] | null {
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])\s*?\n?```/)
  const rawJson = jsonBlockMatch?.[1] || text
  try {
    const parsed = JSON.parse(rawJson)
    if (!Array.isArray(parsed)) return null
    const suggestions: import('@/stores/workbench-store').EditSuggestion[] = []
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i]
      if (typeof item.original === 'string' && typeof item.replacement === 'string') {
        suggestions.push({
          id: `edit-${Date.now()}-${i}`,
          original: item.original,
          replacement: item.replacement,
          reason: item.reason || '',
        })
      }
    }
    return suggestions.length > 0 ? suggestions : null
  } catch {
    return null
  }
}

// 检测内容是否为 Craft 模式的 JSON 编辑建议（用于 UI 渲染判断）
function isCraftJsonContent(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) && parsed.length > 0 &&
        typeof parsed[0].original === 'string' && typeof parsed[0].replacement === 'string'
    } catch { return false }
  }
  // 也检测 markdown 代码块包裹的 JSON
  const blockMatch = trimmed.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])\s*?\n?```/)
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1])
      return Array.isArray(parsed) && parsed.length > 0 &&
        typeof parsed[0].original === 'string' && typeof parsed[0].replacement === 'string'
    } catch { return false }
  }
  return false
}

// 将 Craft JSON 渲染为友好的摘要卡片信息
function craftSummaryFromJson(text: string): { count: number; preview: string } {
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?(\[[\s\S]*?\])\s*?\n?```/)
  const rawJson = jsonBlockMatch?.[1] || text
  try {
    const parsed = JSON.parse(rawJson)
    if (!Array.isArray(parsed)) return { count: 0, preview: '' }
    return {
      count: parsed.length,
      preview: parsed.slice(0, 3).map((item: any, i: number) =>
        `${i + 1}. ${item.reason || '修改建议'}`
      ).join('\n'),
    }
  } catch {
    return { count: 0, preview: '' }
  }
}

// 尝试提取思考链内容（部分模型返回 reasoning_content / thinking 字段）
function extractThinking(rawContent: string): { thinking: string; cleanContent: string } {
  // 匹配 <thinking>...</thinking> 标签
  const thinkTagMatch = rawContent.match(/<thinking>([\s\S]*?)<\/thinking>/)
  if (thinkTagMatch) {
    return {
      thinking: thinkTagMatch[1].trim(),
      cleanContent: rawContent.replace(/<thinking>[\s\S]*?<\/thinking>/, '').trim(),
    }
  }
  // 匹配 ～～～思考～～～ 或类似中文标记
  const cnThinkMatch = rawContent.match(/(?:【思考】|【推理】|~~思考~~)[\s\S]*?(?:【\/思考】|【\/推理】|~~\/思考~~|$)/)
  if (cnThinkMatch) {
    return {
      thinking: cnThinkMatch[0].replace(/[【】\/~~]/g, '').trim(),
      cleanContent: rawContent.replace(cnThinkMatch[0], '').trim(),
    }
  }
  return { thinking: '', cleanContent: rawContent }
}

// Agent 工具调用轨迹中的单行展示（文档 M2）
function ToolEventLine({ event }: { event: AgentLoopEvent }) {
  if (event.type === 'tool_use') {
    return (
      <div className="flex items-center gap-1 text-[10px] text-foreground/70">
        <Wrench size={10} className="text-primary flex-shrink-0" />
        <span className="truncate">调用 {event.name}({JSON.stringify(event.arguments ?? {}).slice(0, 60)})</span>
      </div>
    )
  }
  if (event.type === 'tool_result') {
    const ok = event.result.success
    return (
      <div className={cn('flex items-center gap-1 text-[10px]', ok ? 'text-green-400/80' : 'text-red-400/80')}>
        <span className="flex-shrink-0">{ok ? '✓' : '✗'}</span>
        <span className="truncate">
          {event.name}：
          {ok
            ? typeof event.result.result === 'string'
              ? event.result.result.slice(0, 60)
              : '已获取资料'
            : event.result.error}
        </span>
      </div>
    )
  }
  return null
}

export default function AiChatPanel({ novelId }: { novelId: string }) {
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)
  const updateAgentConfig = useSettingsStore((s) => s.updateAgentConfig)
  const editorContent = useWorkbenchStore((s) => s.editorContent)
  const selectedChapter = useWorkbenchStore((s) => s.selectedChapter)
  const setEditorContent = useWorkbenchStore((s) => s.setEditorContent)
  const reloadEditor = useWorkbenchStore((s) => s.reloadEditor)
  // IMP-03：写作模式下若模型未调用 rewrite_chapter，正文只会留在聊天气泡里——提供显式写入入口
  const [pendingWrite, setPendingWrite] = useState<{ chapterId: string; title: string; content: string } | null>(null)

  // 共享状态
  const setEditSuggestions = useWorkbenchStore((s) => s.setEditSuggestions)
  const clearEditSuggestions = useWorkbenchStore((s) => s.clearEditSuggestions)
  const addThinkingStep = useWorkbenchStore((s) => s.addThinkingStep)
  const clearThinkingSteps = useWorkbenchStore((s) => s.clearThinkingSteps)
  const addTokenUsage = useWorkbenchStore((s) => s.addTokenUsage)
  const tokenUsageHistory = useWorkbenchStore((s) => s.tokenUsageHistory)
  const clearTokenUsage = useWorkbenchStore((s) => s.clearTokenUsage)
  const pendingSkillInject = useWorkbenchStore((s) => s.pendingSkillInject)
  const setPendingSkillInject = useWorkbenchStore((s) => s.setPendingSkillInject)

  // P1：技能面板「注入对话」- 接收来自 SkillPanel 的指令并聚焦输入框
  useEffect(() => {
    if (pendingSkillInject) {
      setInputValue(pendingSkillInject)
      inputRef.current?.focus()
      setPendingSkillInject(null)
    }
  }, [pendingSkillInject, setPendingSkillInject])

  const [messages, setMessages] = useState<ChatMessage[]>(() => [getDefaultWelcome(AGENTS[0].name)])
  const [inputValue, setInputValue] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeAgent, setActiveAgent] = useState(AGENTS[0])
  const [showAgentMenu, setShowAgentMenu] = useState(false)
  const [chatMode, setChatMode] = useState<ChatMode>('writing')
  // Agent 工具循环事件（文档 M2）：实时展示 AI 正在调资料
  const [toolEvents, setToolEvents] = useState<AgentLoopEvent[]>([])
  const handleToolEvent = useCallback((e: AgentLoopEvent) => {
    setToolEvents((prev) => [...prev, e])
  }, [])
  // 工具轨迹面板折叠状态
  const [toolEventsCollapsed, setToolEventsCollapsed] = useState(false)
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null)
  // Token 累计
  const [totalTokens, setTotalTokens] = useState({ input: 0, output: 0 })
  // 思考链展开状态
  const [expandedThinking, setExpandedThinking] = useState<string | null>(null)
  // Token 面板展开
  const [showTokenPanel, setShowTokenPanel] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const conversationRef = useRef<{ role: string; content: string }[]>([])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const getAgentConfig = useCallback((): AgentConfig | undefined => {
    // D-T4-2：同角色可能并存空 key 种子行与已配 key 的用户行，必须优先选有 key 的
    return pickAgentForRole(agentConfigs, activeAgent.id)
  }, [agentConfigs, activeAgent.id])

  const loadHistory = useCallback(async (agentId: string) => {
    try {
      const history = await chatService.getByNovelId(novelId, 100)
      const agentMsgs = history
        .filter((m) => m.agentId === agentId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map<ChatMessage>((m) => ({
          id: m.id,
          role: m.role as ChatMessage['role'],
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          timestamp: new Date((m as any).created_at || m.createdAt).getTime(),
        }))
      if (agentMsgs.length > 0) {
        setMessages(agentMsgs)
      } else {
        setMessages([getDefaultWelcome(activeAgent.name)])
      }
    } catch (e) {
      console.error('Failed to load chat history:', e)
      setMessages([getDefaultWelcome(activeAgent.name)])
    }
  }, [novelId, activeAgent.name])

  useEffect(() => {
    loadHistory(activeAgent.id)
    conversationRef.current = []
    clearEditSuggestions()
    clearThinkingSteps()
  }, [loadHistory, activeAgent.id, clearEditSuggestions, clearThinkingSteps])

  const handleSwitchAgent = (agent: typeof AGENTS[0]) => {
    ActionLog.agent('switch', `切换到智能体: ${agent.name} (${agent.id})`)
    setActiveAgent(agent)
    setShowAgentMenu(false)
  }

  const persistMessage = useCallback((msg: ChatMessage) => {
    if (msg.role === 'system' || msg.error) return
    const agentConfig = getAgentConfig()
    chatService.save({
      id: msg.id,
      novelId,
      chapterId: selectedChapter?.id,
      agentId: agentConfig?.id || activeAgent.id,
      role: msg.role,
      content: msg.content,
      tokensUsed: 0,
      createdAt: new Date(msg.timestamp).toISOString(),
    }).catch((e) => console.error('Failed to persist chat message:', e))
  }, [novelId, selectedChapter?.id, activeAgent.id, getAgentConfig])

  const handleClearHistory = async () => {
    try {
      await chatService.deleteByNovelAndAgent(novelId, activeAgent.id)
      setMessages([getDefaultWelcome(activeAgent.name)])
      conversationRef.current = []
      clearEditSuggestions()
      clearThinkingSteps()
      ActionLog.agent('clear-history', `清除 ${activeAgent.name} 会话历史`)
    } catch (e) {
      console.error('Failed to clear chat history:', e)
    }
  }

  const handleCopy = async (msg: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(msg.content)
      setCopiedMsgId(msg.id)
      setTimeout(() => setCopiedMsgId(null), 2000)
    } catch { /* fallback */ }
  }

  // IMP-03：把生成结果写回章节文件并刷新编辑器（此前唯一出口只有"复制"）
  const handleWriteToChapter = async () => {
    if (!pendingWrite) return
    try {
      await chapterService.saveContent(pendingWrite.chapterId, pendingWrite.content, { source: 'ai', novelId })
      setEditorContent(pendingWrite.content)
      reloadEditor()
      ActionLog.agent('write-to-chapter', `写入 ${pendingWrite.title}（${pendingWrite.content.length} 字）`)
      setPendingWrite(null)
    } catch (e) {
      console.error('Write to chapter failed:', e)
      ActionLog.error('写入本章失败', { chapterId: pendingWrite.chapterId, error: e })
    }
  }

  const handleSend = async (override?: string) => {
    const userContent = normalizeInput(override ?? inputValue)
    if (!userContent || isStreaming) return

    ActionLog.agent('send-message', `智能体=${activeAgent.name}, 模式=${chatMode}, 内容="${userContent.slice(0, 60)}${userContent.length > 60 ? '…' : ''}"`)
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    }
    setMessages((prev) => [...prev, userMsg])
    persistMessage(userMsg)
    setInputValue('')
    setIsStreaming(true)
    clearEditSuggestions()
    setToolEvents([])

    conversationRef.current.push({ role: 'user', content: userContent })

    const assistantMsgId = `msg-${Date.now()}-ai`
    const assistantMsg: ChatMessage = { id: assistantMsgId, role: 'assistant', content: '', timestamp: Date.now() }
    setMessages((prev) => [...prev, assistantMsg])

    const agentConfig = getAgentConfig()

    if (agentConfig?.apiKeyEncrypted) {
      const abortController = new AbortController()
      abortRef.current = abortController

      try {
        // craft 模式是「编辑建议」而非长写：不按 writing 注入长写流程指令，
        // 否则「必须严格遵循」的写作指令会盖过 craft JSON 指令，LLM 直接输出整章改写正文
        const agentMode: AgentMode = chatMode === 'writing' ? 'writing' : 'ask'
        const streamOptions: BuildContextOptions = {
          novelId,
          volumeId: selectedChapter?.volumeId,
          chapterId: selectedChapter?.id,
          chapter: selectedChapter ?? undefined,
          chapterContent: editorContent,
          chapterTitle: selectedChapter?.title,
          chapterOrder: selectedChapter?.order,
          chapterSummary: selectedChapter?.summary || '',
          chapterHooks: selectedChapter?.hooks,
          previousMessages: conversationRef.current.slice(-10),
          mode: chatMode === 'craft' ? 'craft' : 'chat',
          agentMode,
          enableTools: chatMode === 'writing',
          onToolEvent: handleToolEvent,
        }

        let accumulated = ''
        // 写作模式续写前：剧情记忆保障（导入书/旧书缺摘要时先自动构建知识库）
        if (agentMode === 'writing') {
          const memMsgId = `msg-${Date.now()}-mem`
          let memShown = false
          for await (const p of ensureStoryMemory(novelId, abortController.signal)) {
            if (p.phase === 'done' && !memShown) break // 剧情记忆完整，静默通过
            if (!memShown) {
              setMessages((prev) => [
                ...prev,
                { id: memMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() },
              ])
              memShown = true
            }
            const label =
              p.phase === 'chapter'
                ? `正在构建剧情记忆 ${p.index + 1}/${p.total}《${p.title ?? ''}》${p.message ?? ''}`
                : p.message ?? ''
            setMessages((prev) => prev.map((m) => (m.id === memMsgId ? { ...m, content: label } : m)))
          }
          if (abortController.signal.aborted) return
        }
        // Craft 模式：上次已推送的建议数量，用于增量更新
        let lastPushedEditCount = 0
        for await (const chunk of agentChat(agentConfig, userContent, streamOptions, abortController.signal)) {
          if (chunk.content) accumulated += chunk.content
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: accumulated } : m
            )
          )
          const u = chunk.usage
          if (u) {
            setTotalTokens((prev) => ({
              input: prev.input + (u.inputTokens || 0),
              output: prev.output + (u.outputTokens || 0),
            }))
            addTokenUsage({
              inputTokens: u.inputTokens || 0,
              outputTokens: u.outputTokens || 0,
              model: u.model,
              timestamp: Date.now(),
            })
          }
          // Craft 模式流式增量解析：每收到新内容尝试解析 JSON，有新建议就立即推送
          if (chatMode === 'craft' && accumulated.length > 10) {
            const partialEdits = parseEditSuggestions(accumulated)
            if (partialEdits && partialEdits.length > lastPushedEditCount) {
              setEditSuggestions(partialEdits)
              lastPushedEditCount = partialEdits.length
            }
          }
        }

        // 提取思考链与清理后内容
        const { thinking, cleanContent } = extractThinking(accumulated)
        const finalContent = cleanContent || accumulated

        conversationRef.current.push({ role: 'assistant', content: finalContent })
        const finalMsg: ChatMessage = { ...assistantMsg, content: finalContent, thinking: thinking || undefined }
        setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? finalMsg : m)))
        persistMessage(finalMsg)

        // 记录思考链到共享状态
        if (thinking) {
          addThinkingStep(thinking)
        }

        // craft 模式：解析编辑建议 → 推送到 store → WritingEditor 内联渲染
        if (chatMode === 'craft' && finalContent) {
          const edits = parseEditSuggestions(finalContent)
          if (edits && edits.length > 0) {
            setEditSuggestions(edits)
          }
        }

        // IMP-03：写作模式下若模型没调用 rewrite_chapter，产出只会停在气泡里。
        // 这里挂一个显式写入入口，避免"生成完就丢了，只剩复制按钮"。
        if (chatMode === 'writing' && selectedChapter?.id && finalContent.trim().length > 200) {
          setPendingWrite({
            chapterId: selectedChapter.id,
            title: selectedChapter.title,
            content: finalContent,
          })
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return
        console.error('Agent chat error:', err)
        const classified = classifyError(err)
        ActionLog.agent('chat-error', `${classified.title}: ${classified.message}`)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: '', error: classified } : m
          )
        )
      } finally {
        setIsStreaming(false)
        abortRef.current = null
      }
    } else {
      // Mock 模式
      const responseText = generateMockResponse(userContent, activeAgent.name, chatMode)
      let currentText = ''
      const words = responseText.split('')
      let charIndex = 0
      const interval = setInterval(() => {
        if (charIndex < words.length) {
          currentText += words[charIndex]
          charIndex++
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: currentText } : m
            )
          )
        } else {
          clearInterval(interval)
          setIsStreaming(false)
          const finalMsg: ChatMessage = { ...assistantMsg, content: responseText }
          persistMessage(finalMsg)
          if (chatMode === 'craft') {
            const edits = parseEditSuggestions(responseText)
            if (edits && edits.length > 0) setEditSuggestions(edits)
          }
        }
      }, 15)
      conversationRef.current.push({ role: 'assistant', content: responseText })
    }
  }

  const handleResendLast = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser) handleSend(lastUser.content)
  }

  const handleFallbackRetry = (providerName: string) => {
    const current = getAgentConfig()
    if (!current) return
    const fb = getFallbackProvider(current.provider)
    if (!fb) return
    const info = LLM_PROVIDERS[fb as keyof typeof LLM_PROVIDERS]
    updateAgentConfig(current.id, { provider: fb, model: info?.defaultModel || current.model })
    ActionLog.agent('chat-fallback', `降级到 ${providerName}`)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser) handleSend(lastUser.content)
  }

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
      setIsStreaming(false)
    }
  }

  // 批量改写整卷功能已移除（改由 AI 用 rewrite_chapter 工具自行完成，更灵活）

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleQuickCommand = (cmd: string) => {
    setInputValue(cmd + ' ')
    inputRef.current?.focus()
  }

  const hasApiKey = !!getAgentConfig()?.apiKeyEncrypted
  const toolsUnsupported = !!getAgentConfig() && !supportsTools(getAgentConfig()!)

  // 计算 token 汇总
  const totalInput = totalTokens.input + tokenUsageHistory.reduce((s, u) => s + (u.inputTokens || 0), 0)
  const totalOutput = totalTokens.output + tokenUsageHistory.reduce((s, u) => s + (u.outputTokens || 0), 0)
  const grandTotal = totalInput + totalOutput

  return (
    <div className="h-full flex flex-col select-none">
      {/* IMP-03：正文尚未写入本章的提示 */}
      {pendingWrite && (
        <div className="mx-3 mt-2 px-3 py-2 rounded border border-yellow-500/40 bg-yellow-500/10 text-xs text-yellow-200 flex items-center gap-2">
          <span className="flex-1">
            本章「{pendingWrite.title}」的生成内容（{pendingWrite.content.length} 字）尚未写入章节文件。
          </span>
          <button
            className="px-2 py-1 rounded bg-yellow-500/20 hover:bg-yellow-500/30"
            onClick={handleWriteToChapter}
          >
            写入本章
          </button>
          <button className="px-2 py-1 rounded hover:bg-white/10" onClick={() => setPendingWrite(null)}>
            忽略
          </button>
        </div>
      )}
      {/* Agent Selector */}
      <div className="relative px-3 py-2 border-b border-border/30">
        <button
          onClick={() => setShowAgentMenu(!showAgentMenu)}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm',
            'hover:bg-muted/30 transition-colors'
          )}
        >
          <span>{activeAgent.emoji}</span>
          <span className={cn('font-medium', activeAgent.color)}>{activeAgent.name}</span>
          {hasApiKey ? (
            <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">已连接</span>
          ) : (
            <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 cursor-help" title="当前为模拟模式，回复为预设模板。请在设置中配置 API Key 以启用真实 AI 对话">模拟</span>
          )}
          <ChevronDown size={14} className="text-muted-foreground" />
        </button>

        {showAgentMenu && (
          <div className="absolute left-3 right-3 top-full mt-1 bg-popover border border-border rounded-lg shadow-xl z-10 animate-scale-in overflow-hidden">
            {AGENTS.map((agent) => (
              <button
                key={agent.id}
                onClick={() => handleSwitchAgent(agent)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm',
                  'hover:bg-muted/40 transition-colors',
                  activeAgent.id === agent.id && 'bg-primary/10'
                )}
              >
                <span>{agent.emoji}</span>
                <span className={agent.color}>{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {toolsUnsupported && (
        <div className="mx-3 mt-2 px-2.5 py-1.5 rounded border border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300/90 leading-relaxed">
          当前模型不支持工具调用：写作会使用已装配的章节资料，AI 无法主动查询知识库或改写章节。
        </div>
      )}

      {/* Agent 工具调用轨迹（文档 M2）：可折叠、可滚动 */}
      {toolEvents.length > 0 && (
        <div className="border-b border-border/20 bg-muted/20 animate-fade-in">
          {/* 折叠栏：点击切换 */}
          <button
            onClick={() => setToolEventsCollapsed(!toolEventsCollapsed)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-muted/30 transition-colors cursor-pointer"
          >
            {toolEventsCollapsed ? (
              <ChevronRight size={11} className="text-primary/50 flex-shrink-0" />
            ) : (
              <ChevronDown size={11} className="text-primary/50 flex-shrink-0" />
            )}
            <span className="text-[9px] text-primary/60 font-medium">AI 行动轨迹</span>
            <span className="text-[9px] text-muted-foreground/40">
              ({toolEvents.length} 条)
            </span>
          </button>
          {/* 展开内容区：高度限制 + 滚动 */}
          {!toolEventsCollapsed && (
            <div className="max-h-48 overflow-y-auto px-3 pb-1.5 space-y-0.5">
              {toolEvents.map((e, i) => (
                <ToolEventLine key={i} event={e} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {!hasApiKey && (
          <div className="text-[10px] text-yellow-400/70 bg-yellow-500/5 border border-yellow-500/10 rounded-lg px-2.5 py-1.5">
            <span className="font-medium">模拟模式</span> — 当前回复为预设模板，非真实 AI。前往
            <button onClick={() => window.location.hash = '#/settings'} className="underline hover:text-yellow-300 mx-0.5">设置</button>
            配置 API Key 后启用真实对话。
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'flex gap-2 animate-fade-in group',
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            )}
          >
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-md bg-primary/20 flex items-center justify-center mt-0.5">
                <Bot size={13} className="text-primary" />
              </div>
            )}

            <div
              className={cn(
                'max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed relative',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-tr-sm'
                  : msg.role === 'system'
                    ? 'bg-warning/20 text-yellow-300 text-xs'
                    : 'bg-muted/50 text-foreground rounded-tl-sm'
              )}
            >
              {/* 复制按钮 */}
              {msg.role === 'assistant' && msg.content && !msg.error && (
                <button
                  onClick={() => handleCopy(msg)}
                  className="absolute top-1 right-1 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/50 transition-all"
                  title="复制"
                >
                  {copiedMsgId === msg.id ? <Check size={11} className="text-green-400" /> : <Copy size={11} className="text-muted-foreground" />}
                </button>
              )}

              {msg.role === 'assistant' ? (
                msg.error ? (
                  <ErrorCard
                    error={msg.error}
                    onRetry={() => handleResendLast()}
                    onFallback={msg.error.retryable ? (p) => handleFallbackRetry(p) : undefined}
                    fallbackProviderName={
                      getFallbackProvider(getAgentConfig()?.provider || '')
                        ? LLM_PROVIDERS[getFallbackProvider(getAgentConfig()?.provider || '') as keyof typeof LLM_PROVIDERS]?.name
                        : undefined
                    }
                  />
                ) : (
                  <>
                    {/* 思考链可展开区域 */}
                    {msg.thinking && (
                      <div className="mb-2">
                        <button
                          onClick={() => setExpandedThinking(expandedThinking === msg.id ? null : msg.id)}
                          className="flex items-center gap-1 text-[10px] text-primary/60 hover:text-primary/90 transition-colors"
                        >
                          <Brain size={11} />
                          思考过程
                          <ChevronRight size={10} className={cn(
                            'transition-transform duration-200',
                            expandedThinking === msg.id && 'rotate-90'
                          )} />
                        </button>
                        {expandedThinking === msg.id && (
                          <div className="mt-1.5 p-2 bg-primary/5 border border-primary/10 rounded-lg text-[11px] text-muted-foreground leading-relaxed max-h-40 overflow-y-auto animate-fade-in">
                            {msg.thinking}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Craft 模式 JSON 编辑建议 → 友好摘要卡片 */}
                    {isCraftJsonContent(msg.content) ? (() => {
                      const { count, preview } = craftSummaryFromJson(msg.content)
                      return (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5 text-xs">
                            <Wrench size={12} className="text-primary" />
                            <span className="font-medium text-foreground/90">已生成 {count} 条修改建议</span>
                          </div>
                          <div className="text-[11px] text-muted-foreground/80 leading-relaxed space-y-0.5 pl-4">
                            {preview.split('\n').map((line, i) => (
                              <div key={i}>{line}</div>
                            ))}
                            {count > 3 && <div className="text-muted-foreground/50 italic">...还有 {count - 3} 条建议</div>}
                          </div>
                          <div className="text-[10px] text-primary/70 bg-primary/5 rounded-md px-2 py-1 inline-block">
                            请在左侧编辑器中查看并 Accept / Reject 每条建议
                          </div>
                        </div>
                      )
                    })() : (
                    /* 普通 Markdown 内容 */
                    <div className="prose prose-sm prose-invert max-w-none text-[13px] leading-relaxed
                      [&_h1]:text-base [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1 [&_h1]:text-foreground
                      [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-foreground
                      [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-foreground
                      [&_p]:my-1.5 [&_p]:text-foreground/90
                      [&_strong]:font-semibold [&_strong]:text-foreground
                      [&_ul]:list-disc [&_ul]:ml-4 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:ml-4 [&_ol]:my-1
                      [&_li]:text-foreground/90
                      [&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:text-primary
                      [&_pre]:bg-muted/30 [&_pre]:p-2 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                    )}
                  </>
                )
              ) : (
                <span>{msg.content}</span>
              )}

              {msg.role === 'assistant' && isStreaming && msg === messages[messages.length - 1] && !msg.error && (
                <span className="inline-block w-1.5 h-4 bg-primary ml-0.5 animate-streaming-cursor align-middle" />
              )}
            </div>

            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-6 h-6 rounded-md bg-muted/50 flex items-center justify-center mt-0.5">
                <User size={13} className="text-muted-foreground" />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick Commands */}
      <div className="px-3 py-1.5 border-t border-border/20 flex gap-1 overflow-x-auto">
        {QUICK_COMMANDS.map((cmd) => (
          <button
            key={cmd.label}
            onClick={() => handleQuickCommand(cmd.label)}
            className={cn(
              'flex-shrink-0 flex items-center gap-1 px-2 py-1',
              'rounded text-[10px] transition-colors',
              'bg-muted/30 text-muted-foreground',
              'hover:text-foreground hover:bg-muted/50'
            )}
          >
            <cmd.icon size={11} />
            {cmd.label}
          </button>
        ))}
      </div>

      {/* Input Area */}
      <div className="border-t border-border/30">
        {/* 底部工具栏 */}
        <div className="px-3 pt-1.5 pb-0 flex items-center justify-between text-[9px] text-muted-foreground/60">
          {/* 左侧：模式切换 */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setChatMode('ask')}
              className={cn(
                'flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors',
                chatMode === 'ask' ? 'bg-primary/15 text-primary' : 'hover:text-foreground'
              )}
              title="问询模式：纯文本对话（仍注入本书资料）"
            >
              <MessageSquare size={10} /> 问询
            </button>
            <span className="text-border/30">|</span>
            <button
              onClick={() => setChatMode('writing')}
              className={cn(
                'flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors',
                chatMode === 'writing' ? 'bg-green-500/15 text-green-400' : 'hover:text-foreground'
              )}
              title="写作 Agent：自动调取大纲/角色/世界观/追踪状态后撰写（真正的 agent 能力）"
            >
              <PenLine size={10} /> 写作
            </button>
            <span className="text-border/30">|</span>
            <button
              onClick={() => setChatMode('craft')}
              className={cn(
                'flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors',
                chatMode === 'craft' ? 'bg-primary/15 text-primary' : 'hover:text-foreground'
              )}
              title="Craft 模式：AI 返回逐句修改建议，可直接应用到左侧编辑器原文"
            >
              <Wrench size={10} /> Craft
            </button>
            <span className="text-border/30">|</span>
            {/* 批量改写整卷按钮已移除（改由 AI 用 rewrite_chapter 工具自行完成） */}
          </div>

          {/* 右侧：Token + 清除 */}
          <div className="flex items-center gap-2">
            {/* Token 统计（始终显示，可展开明细） */}
            <button
              onClick={() => setShowTokenPanel(!showTokenPanel)}
              className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
              title="点击查看 Token 消耗明细"
            >
              📊 {grandTotal > 0 ? grandTotal.toLocaleString() : '—'}
            </button>
            <button
              onClick={handleClearHistory}
              className="flex items-center gap-0.5 hover:text-red-400 transition-colors"
              title="清空当前智能体会话历史"
            >
              <Trash2 size={10} /> 清除
            </button>
          </div>
        </div>

        {/* Token 消耗明细面板（参考 CodeBuddy 风格） */}
        {showTokenPanel && (
          <div className="mx-3 mb-2 border border-border/30 rounded-lg p-2.5 bg-muted/20 animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-semibold text-foreground/80">Token 消耗明细</span>
              <button onClick={() => { setShowTokenPanel(false); clearTokenUsage(); setTotalTokens({ input: 0, output: 0 }) }}
                className="text-[9px] text-muted-foreground/50 hover:text-red-400">重置</button>
            </div>
            {grandTotal > 0 ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
              <div className="flex justify-between"><span className="text-muted-foreground/60">总计</span><span className="font-mono font-medium">{grandTotal.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground/60">输入</span><span className="font-mono text-blue-300">{totalInput.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground/60">输出</span><span className="font-mono text-green-300">{totalOutput.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground/60">模型</span><span>{tokenUsageHistory[tokenUsageHistory.length - 1]?.model || '-'}</span></div>
              {tokenUsageHistory.length > 1 && (
                <div className="col-span-2 mt-1 pt-1 border-t border-border/20">
                  <span className="text-muted-foreground/50">共 {tokenUsageHistory.length} 次调用</span>
                </div>
              )}
            </div>
            ) : (
              <div className="text-[10px] text-muted-foreground/40 text-center py-2">暂无 Token 消耗记录</div>
            )}
          </div>
        )}

        {/* 输入框 */}
        <div className="px-3 py-2">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                chatMode === 'craft'
                  ? 'Craft 模式 — 描述需要的修改，AI 将返回逐句建议...'
                  : chatMode === 'writing'
                    ? '写作 Agent — 描述要写/续写/润色的内容，AI 会自动调取大纲、角色与世界观...'
                    : '输入消息或使用快捷指令...'
              }
              rows={2}
              className={cn(
                'flex-1 px-3 py-2 rounded-lg resize-none',
                'bg-muted/50 border border-border/50',
                'text-sm text-foreground placeholder:text-muted-foreground/50',
                'focus:outline-none focus:ring-1 focus:ring-primary/30',
                'transition-all duration-150',
                // 关键：父容器 select-none 会禁用文本选择，导致光标不显示；此处显式恢复
                'select-text'
              )}
            />
            {isStreaming && hasApiKey ? (
              <button
                onClick={handleStop}
                className={cn(
                  'p-2 rounded-lg flex-shrink-0',
                  'bg-red-500/20 text-red-400 hover:bg-red-500/30',
                  'transition-all duration-150'
                )}
              >
                <StopCircle size={16} />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!inputValue.trim() || isStreaming}
                className={cn(
                  'p-2 rounded-lg flex-shrink-0',
                  'bg-primary text-primary-foreground',
                  'hover:opacity-90 active:scale-95',
                  'transition-all duration-150',
                  'disabled:opacity-40 disabled:cursor-not-allowed'
                )}
              >
                {isStreaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Mock response generator (fallback when no API key)
function generateMockResponse(input: string, agentName: string, mode: ChatMode): string {
  if (mode === 'craft') {
    return `以下是基于当前文本的逐句修改建议：

\`\`\`json
[
  {
    "original": "阳光从窗户外面照了进来已经很久了",
    "replacement": "阳光斜斜地穿过窗棂，在地板上投下斑驳的光影，已经这样静静地铺陈了很久。",
    "reason": "增强画面感与氛围描写"
  },
  {
    "original": "拿起了枕头边上的手机看了一眼时间",
    "replacement": "他的手探向枕边，指尖触到手机冰凉的金属外壳。屏幕亮起——十点整。",
    "reason": "拆解动作为有层次的细节"
  },
  {
    "original": "整个人显得精神一些",
    "replacement": "他深吸一口气，感觉浑浊的思绪像被这口新鲜空气冲淡了几分。",
    "reason": "用感官体验替代概括性描述"
  }
]
\`\`\`

点击左侧编辑器内的 **Accept** 应用修改，**Reject** 忽略该条建议。所有修改将直接反映在原文中。`
  }

  if (input.includes('润色')) {
    return `### 润色建议

我仔细阅读了这段文字，以下是润色方向：

**整体评价**：叙事流畅，但部分描写可以更细腻、更有画面感。

**具体修改**：

1. **开头氛围** — 原文"阳光从窗户外面照了进来已经很久了"略显口语化，建议改为：
   > 阳光斜斜地穿过窗棂，在地板上投下斑驳的光影，已经这样静静地铺陈了很久。

2. **动作细节** — "拿起了枕头边上的手机看了一眼时间"可以拆解为更有层次的动作：
   > 他的手探向枕边，指尖触到手机冰凉的金属外壳。屏幕亮起——十点整。

3. **情感铺垫** — "整个人显得精神一些"偏概括，可以加入感官描写：
   > 他深吸一口气，感觉浑浊的思绪像被这口新鲜空气冲淡了几分。

需要我对某一段做更详细的改写吗？`
  }

  if (input.includes('去AI') || input.includes('去ai') || input.includes('去AI味')) {
    return `### 去AI化处理

以下是对文本的去AI化修改建议：

**主要问题识别**：
- 过度使用排比句式（"……的……，……的……"）
- 形容词堆砌（"非常""格外""十分"等程度副词过多）
- 句式过于工整，缺乏自然口语感
- 情感表达直白，缺少含蓄留白

**修改示例**：

原文：
> *她感到非常难过，眼泪不由自主地流了下来。她的心像被刀割一样痛。*

去AI后：
> *她没说话，只是低着头盯着自己的脚尖。过了好一会儿，才听见一声很轻的抽泣。*

**核心原则**：少用形容词，多用动词和名词；让动作和细节替人物"说话"；适当保留不完美和冗余，那才是真实语言的样子。

要我逐段处理吗？`
  }

  if (input.includes('续写')) {
    return `好的，我来帮你续写接下来的内容。基于当前剧情发展，我建议以下方向：

**续写建议**：

林越收回了目光，他知道，这只是开始。剑意初成不过是踏入了剑道的门槛，真正的大道还在前方。

就在这时，剑阁深处传来一声悠长的钟鸣。

铛——铛——铛——

三声钟响，意味着宗门有大事发生。林越眉头微皱，身形一闪，朝剑阁下方掠去。

大殿前的广场上已经聚集了不少弟子，人人面色凝重。林越一眼就看到了人群中脸色发白的师弟李牧。

"发生什么事了？"

李牧压低声音道："林师兄，出大事了...魔渊的封印，松动了。"

林越瞳孔猛地一缩。`
  }

  if (input.includes('节奏') || input.includes('拖沓')) {
    return `### 关于节奏的分析

我仔细看了一下，确实存在一些节奏问题：

**问题定位**：
1. **开头冗长** — 前两段总计 150+ 字都在铺垫氛围，对于网文读者来说耐心消耗较快
2. **中段密度不够** — "三天"的叙述略显平铺直叙，可以考虑加入一些时间跳跃中的关键瞬间

**改进建议**：

将开头精炼为：

> 林越在剑阁之巅站了三天，终于在青莲剑仙留下的那道裂痕中，捕捉到了一丝剑意的边缘。那不是招式，而是一种与天地共鸣的节奏。

这样可以直接切入核心，保留意境的同时加快节奏。`
  }

  if (input.includes('审查') || input.includes('分析')) {
    return `### 章节结构审查

整体评分: **7.2/10**

**优点**：
- 主线清晰，主角目标明确
- 打斗场面节奏尚可
- 结尾悬念铺垫不错

**需改进**：
- 第2段信息密度偏低，可精简30%
- 对话部分略显僵硬，建议增加人物微表情和动作描写
- 场景切换缺乏过渡句

具体修改建议请告诉我，我可以逐段分析。`
  }

  return `作为**${agentName}**，我收到了你的讯息。

关于"${input.slice(0, 30)}${input.length > 30 ? '...' : ''}"这个问题，我的分析如下：

**要点**：
- 这个方向整体是可取的
- 需要注意前后文的连贯性
- 可以考虑在关键节点加入更多张力

需要我深入某个方面的话，请告诉我。`
}
