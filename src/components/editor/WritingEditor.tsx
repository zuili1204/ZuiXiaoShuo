import { useState, useCallback, useRef, useEffect } from 'react'
import { Bold, Italic, Heading1, Heading2, Code, Eye, Columns, FileText, Check, X, Sparkles, History, ShieldCheck, ShieldAlert, ListTree, ClipboardList, Layers, Gauge, BookCheck, GitCompare } from 'lucide-react'
import { useWorkbenchStore, useSettingsStore } from '@/stores'
import { chapterService } from '@/services/data-service'
import { pickAgentForRole } from '@/services/agent-service'
import { chat } from '@/services/llm-service'
import { commitChapterAndSave } from '@/services/tracking-service'
import { runQualityGate } from '@/services/quality-service'
import { checkChapterContinuity } from '@/services/story-check-service'
import { createSnapshot } from '@/services/snapshot-service'
import { indexChapterContent, loadIndex } from '@/services/rag-service'
import { knowledgeService } from '@/services/knowledge-service'
import { flushSession } from '@/services/session-service'
import { ActionLog } from '@/services/log-service'
import { useShortcut } from '@/hooks/useShortcut'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '@/utils/cn'
import { countWords } from '@/utils/charcount'
import type { Chapter } from '@shared/types'

export default function WritingEditor({ novelId }: { novelId: string }) {
  const {
    editorContent, editorMode, isDirty,
    setEditorContent, setEditorMode, setDirty, setWordCount, wordCount,
    selectedChapter, selectChapter, editorReloadKey,
    editSuggestions, acceptEditSuggestion, rejectEditSuggestion, clearEditSuggestions,
    editorDrawer, setEditorDrawer,
  } = useWorkbenchStore()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [localContent, setLocalContent] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const previousChapterIdRef = useRef<string | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const agentConfigs = useSettingsStore((s) => s.agentConfigs)
  const [finishing, setFinishing] = useState(false)
  const [finishMsg, setFinishMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string; retry?: boolean } | null>(null)
  // P1：保存后的连贯性提示（非阻断）；同一章 20 秒内最多重算一次
  const [continuityWarn, setContinuityWarn] = useState<{ chapterId: string; blocking: number; warnings: number } | null>(null)
  const continuityThrottleRef = useRef<{ chapterId: string | null; at: number }>({ chapterId: null, at: 0 })
  // 保存失败待重试队列：chapterId -> 失败时的内容（重试时若仍是当前章则用编辑器最新内容覆盖）
  const retryQueueRef = useRef<Map<string, string>>(new Map())

  // 全量最新态引用：供 flush / 卸载兜底读取「编辑器当前显示」的章节与内容
  const latestStateRef = useRef({ id: '', content: '', dirty: false })
  latestStateRef.current = {
    id: selectedChapter?.id ?? '',
    content: localContent,
    dirty: isDirty,
  }

  // F2：手动 AI 率检测 —— 先开抽屉给即时反馈；检测状态与结果由 store 按章节管理
  const handleAiRateCheck = useCallback(() => {
    setEditorDrawer('ai-rate')
    void useWorkbenchStore.getState().runAiReportCheck()
  }, [setEditorDrawer])

  // P1：保存后跑一次确定性连贯性检查，只做提示，不阻断保存
  const runContinuityWarn = useCallback(async (chapter: Chapter, value: string) => {
    if (!value.trim()) {
      setContinuityWarn(null)
      return
    }
    const now = Date.now()
    if (
      continuityThrottleRef.current.chapterId === chapter.id &&
      now - continuityThrottleRef.current.at < 20_000
    ) return
    continuityThrottleRef.current = { chapterId: chapter.id, at: now }
    try {
      const findings = await checkChapterContinuity({
        novelId,
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        hooks: chapter.hooks ?? [],
        content: value,
      })
      if (useWorkbenchStore.getState().selectedChapter?.id !== chapter.id) return
      setContinuityWarn({
        chapterId: chapter.id,
        blocking: findings.filter((f) => f.severity === 'blocking').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
      })
    } catch (e) {
      // 检查失败不打断写作与保存
      console.warn('[continuity] save-time check skipped:', e)
    }
  }, [novelId])

  // 切换章节时清空上一章的提示
  useEffect(() => {
    setContinuityWarn(null)
  }, [selectedChapter?.id])

  // D-T1-1 修复：把「已显示在编辑器但仍在 debounce 等待」的内容立即落盘。
  // 章节切换 / 外部 reloadEditor（editorReloadKey）都会清掉 pending timer，
  // 若不 flush，编辑器回显的内容不会落盘（续写/改写产出丢失的根因）。
  const flushPendingSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }
    const { id, content, dirty } = latestStateRef.current
    if (!id || !dirty || !content) return Promise.resolve()
    latestStateRef.current.dirty = false
    return chapterService.saveContent(id, content, { source: 'manual', novelId }).then(() => {
      retryQueueRef.current.delete(id)
      setSaveMsg(null)
    }).catch((err) => {
      // 失败时恢复 dirty 并进入重试队列，避免「已回显但未落盘」被静默吞掉
      latestStateRef.current.dirty = true
      retryQueueRef.current.set(id, content)
      setSaveMsg({ ok: false, text: `章节内容未能保存：${(err as Error)?.message || '未知错误'}`, retry: true })
      console.error('Flush save failed:', err)
    })
  }, [novelId])

  // 进入标题编辑态时自动聚焦并全选。
  // 用 useEffect 保证在 React 提交 DOM 之后再聚焦，取代 setTimeout(0) 的不可靠时序——
  // 后者可能在 input 挂载前就执行（titleInputRef.current 为 null），导致输入框出现却无光标。
  useEffect(() => {
    if (!editingTitle) return
    const input = titleInputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [editingTitle])

  // Load chapter content when selection changes
  useEffect(() => {
    const currentId = selectedChapter?.id ?? null
    const previousId = previousChapterIdRef.current

    // 先丢弃未触发的自动保存 timer
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = undefined
    }

    // D-T1-1：同章外部刷新（editorReloadKey，如流水线回写）且有未落盘改动时，
    // 先 flush 再从磁盘加载，消除「编辑器已回显但不落盘」与写读竞态
    const flushPromise =
      previousId && previousId === currentId && isDirty
        ? flushPendingSave()
        : Promise.resolve()

    // Save previous chapter before switching
    if (previousId && previousId !== currentId) {
      if (isDirty) {
        chapterService.saveContent(previousId, localContent, { source: 'manual', novelId })
          .then(() => flushSession(novelId))
          .catch((err) => {
            retryQueueRef.current.set(previousId, localContent)
            setSaveMsg({ ok: false, text: `上一章未能保存：${(err as Error)?.message || '未知错误'}`, retry: true })
            console.error('Failed to save previous chapter:', err)
          })
      } else {
        // 切章即结束当前写作会话，让「今日字数」与章节归属及时落盘
        void flushSession(novelId)
      }
    }

    previousChapterIdRef.current = currentId

    if (!selectedChapter) {
      setLocalContent('')
      setWordCount(0)
      setEditorContent('')
      setDirty(false)
      clearEditSuggestions()
      return
    }

    // Load the new chapter content
    let cancelled = false
    setIsLoading(true)
    async function loadContent() {
      try {
        await flushPromise
        const content = await chapterService.loadContent(selectedChapter!.id)
        if (cancelled) return
        const text = typeof content === 'string' ? content : ''
        setLocalContent(text)
        setEditorContent(text)
        setWordCount(countWords(text))
        setDirty(false)
      } catch (err) {
        console.error('Failed to load chapter content:', err)
        if (!cancelled) {
          setLocalContent('')
          setEditorContent('')
          setWordCount(0)
          setDirty(false)
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadContent()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChapter?.id, editorReloadKey])

  // P0：保存后运行质量门禁（去AI味检测），结果写入 store 供状态卡展示
  const runQualityCheck = useCallback(async (text: string) => {
    const setQualityGate = useWorkbenchStore.getState().setQualityGate
    const setQualityChecking = useWorkbenchStore.getState().setQualityChecking
    if (!text || text.length < 50) {
      setQualityGate(null)
      return
    }
    setQualityChecking(true)
    try {
      const gate = await runQualityGate(text)
      setQualityGate(gate)
    } catch (e) {
      console.error('Quality check failed:', e)
    } finally {
      setQualityChecking(false)
    }
  }, [])

  // Auto-save with debounce (write to file)
  // 关键：localContent 是 textarea 的唯一数据源；editorContent 即时镜像到 store，
  // 供 AI 对话上下文（AiChatPanel 的 chapterContent）实时读取最新内容。
  // 仅"落盘"用 3000ms debounce，避免每次按键都写文件。
  const handleContentChange = useCallback((value: string) => {
    setLocalContent(value)
    setEditorContent(value)
    setDirty(true)

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
    }

    saveTimerRef.current = setTimeout(() => {
      const chapter = selectedChapter
      if (chapter?.id) {
        chapterService.saveContent(chapter.id, value, { source: 'manual', novelId })
          .then(() => {
            retryQueueRef.current.delete(chapter.id)
            setSaveMsg(null)
            setDirty(false)
            indexChapterContent(
              novelId,
              chapter.id,
              chapter.title,
              value,
              chapter.order
            )
            runQualityCheck(value)
            void runContinuityWarn(chapter, value)
            // 保存即留底（auto 来源，服务内 10 分钟限流）
            createSnapshot(chapter.id, 'auto').catch(() => {})
          })
          .catch((err) => {
            console.error('Auto-save failed:', err)
            // IMP-03：保存失败必须让用户看见。静默吞错会导致"正文其实丢了，界面却显示已保存"
            retryQueueRef.current.set(chapter.id, value)
            setSaveMsg({ ok: false, text: `自动保存失败：${(err as Error)?.message || '未知错误'}`, retry: true })
          })
      }
    }, 3000)
  }, [selectedChapter, setDirty, setEditorContent, novelId, runQualityCheck, runContinuityWarn])

  // 场景面板等外部模块回写的正文：落进本地缓冲并复用正常自动保存链路
  const externalEditorEdit = useWorkbenchStore((s) => s.externalEditorEdit)
  const appliedExternalNonceRef = useRef(0)
  useEffect(() => {
    if (!externalEditorEdit || externalEditorEdit.nonce === appliedExternalNonceRef.current) return
    appliedExternalNonceRef.current = externalEditorEdit.nonce
    if (externalEditorEdit.chapterId !== selectedChapter?.id) return
    handleContentChange(externalEditorEdit.content)
  }, [externalEditorEdit, selectedChapter?.id, handleContentChange])

  // Ctrl/⌘+S 手动保存
  const handleSave = useCallback(() => {
    if (!selectedChapter?.id || !localContent) return
    chapterService.saveContent(selectedChapter.id, localContent, { source: 'manual', novelId })
      .then(() => {
        retryQueueRef.current.delete(selectedChapter.id)
        setSaveMsg(null)
        setDirty(false)
        indexChapterContent(
          novelId,
          selectedChapter.id,
          selectedChapter.title,
          localContent,
          selectedChapter.order
        )
        runQualityCheck(localContent)
        void runContinuityWarn(selectedChapter, localContent)
        // 手动保存同样留底（auto 限流，不刷屏）
        createSnapshot(selectedChapter.id, 'auto').catch(() => {})
        ActionLog.chapter('手动保存成功', { chapterId: selectedChapter.id, title: selectedChapter.title, chars: localContent.length })
      })
      .catch((err) => {
        console.error('Manual save failed:', err)
        ActionLog.error('手动保存失败', { chapterId: selectedChapter.id, title: selectedChapter.title, error: err })
        retryQueueRef.current.set(selectedChapter.id, localContent)
        setSaveMsg({ ok: false, text: `保存失败：${(err as Error)?.message || '未知错误'}`, retry: true })
      })
  }, [selectedChapter, localContent, novelId, setDirty, runQualityCheck, runContinuityWarn])

  // 重试所有失败保存；当前章优先使用编辑器里最新内容，避免重试把旧稿写回
  const handleRetrySave = useCallback(async () => {
    const entries = Array.from(retryQueueRef.current.entries())
    if (!entries.length) {
      setSaveMsg(null)
      return
    }
    let failed = 0
    for (const [id, content] of entries) {
      const latest = latestStateRef.current
      const text = id === latest.id ? latest.content : content
      try {
        await chapterService.saveContent(id, text, { source: 'manual', novelId })
        retryQueueRef.current.delete(id)
        if (id === latest.id && selectedChapter?.id === id) {
          setDirty(false)
          indexChapterContent(novelId, id, selectedChapter.title, text, selectedChapter.order)
          runQualityCheck(text)
        }
      } catch {
        failed++
        retryQueueRef.current.set(id, text)
      }
    }
    setSaveMsg(
      failed > 0
        ? { ok: false, text: `仍有 ${failed} 个章节保存失败，请检查磁盘权限或稍后再试`, retry: true }
        : { ok: true, text: '已重新保存' }
    )
    ActionLog.chapter('重试保存', { failed, total: entries.length })
  }, [novelId, selectedChapter, setDirty, runQualityCheck])

  useShortcut({ 'mod+s': handleSave }, [handleSave])

  // Accept 编辑建议 → 直接修改本地内容并同步到 store
  // 使用模糊匹配（归一化空白后定位）以应对 AI 返回的 original 与编辑器内容存在微小差异的情况
  const handleAcceptEdit = useCallback((edit: { id: string; original: string; replacement: string }) => {
    const current = localContent
    if (!current) return

    const normalize = (s: string) => s.replace(/\s+/g, '')
    const normOriginal = normalize(edit.original)
    const normCurrent = normalize(current)

    let matchStart = normCurrent.indexOf(normOriginal)
    let resolvedOriginal = edit.original
    let rawStart = 0
    let rawEnd = current.length

    function mapNormRangeToRaw(normStart: number, normLen: number) {
      let acc = 0
      let s = 0
      let e = current.length
      for (let i = 0; i < current.length; i++) {
        if (/\s/.test(current[i])) continue
        if (acc === normStart) s = i
        if (acc === normStart + normLen - 1) { e = i + 1; break }
        acc++
      }
      return { s, e }
    }

    if (matchStart === -1) {
      // 严格匹配失败，尝试更宽松的子串匹配（取 original 前 50% 归一化后在内容中找）
      const partial = normalize(edit.original.slice(0, Math.max(10, Math.floor(edit.original.length * 0.5))))
      const pIdx = normCurrent.indexOf(partial)
      if (pIdx === -1) {
        console.warn('Edit suggestion original text not found in current editor content, edit id:', edit.id)
        return
      }
      matchStart = pIdx
      const endNorm = Math.min(normCurrent.length, pIdx + normOriginal.length)
      const range = mapNormRangeToRaw(pIdx, endNorm - pIdx)
      rawStart = range.s
      rawEnd = range.e
      resolvedOriginal = current.slice(rawStart, rawEnd)
    } else {
      const range = mapNormRangeToRaw(matchStart, normOriginal.length)
      rawStart = range.s
      rawEnd = range.e
      resolvedOriginal = current.slice(rawStart, rawEnd)
    }

    const newContent = current.slice(0, rawStart) + edit.replacement + current.slice(rawEnd)
    handleContentChange(newContent)
    acceptEditSuggestion(edit.id)
    ActionLog.agent('accept-edit', `接受修改: "${edit.original.slice(0, 30)}..." → "${edit.replacement.slice(0, 30)}..."`)
  }, [localContent, handleContentChange, acceptEditSuggestion])

  const handleRejectEdit = useCallback((id: string) => {
    rejectEditSuggestion(id)
  }, [rejectEditSuggestion])

  // 完成本章
  const handleFinishChapter = useCallback(async () => {
    if (!selectedChapter || !localContent.trim()) return
    const checker = pickAgentForRole(agentConfigs, 'checker')
    setFinishing(true)
    setFinishMsg(null)
    try {
      if (!checker?.apiKeyEncrypted) {
        const next = await commitChapterAndSave(novelId, {
          chapterId: selectedChapter.id,
          chapterTitle: selectedChapter.title,
          summary: localContent.slice(0, 200),
          wordCount: wordCount,
          keyEvents: localContent.split('\n').filter((l) => l.trim()).slice(0, 5),
          charactersInvolved: [],
          newForeshadowings: [],
          resolvedForeshadowings: [],
          plotQuestions: [],
          // IMP-03：一并把正文落盘（否则只更新元信息，md 仍为空）
          content: localContent,
          source: 'manual',
        })
        // 知识库联动：即使无 checker，也把本地摘要写入 KB
        try {
          await knowledgeService.applyChapterBrief(novelId, selectedChapter.id, {
            summary: localContent.slice(0, 200),
            keyEvents: localContent.split('\n').filter((l) => l.trim()).slice(0, 5),
            charactersInvolved: [],
            newForeshadowings: [],
            resolvedForeshadowings: [],
            nextChapterHook: '',
          })
        } catch (e) {
          console.warn('[finish-chapter] kb apply failed:', e)
        }
        // 完成本章：关键节点强制快照
        createSnapshot(selectedChapter.id, 'finish').catch(() => {})
        setFinishMsg({ ok: true, text: `已更新状态卡（${next.committedChapters.length} 章）` })
        ActionLog.agent('tracking-commit', `${selectedChapter.title} (本地摘要)`)
        return
      }
      const prompt = `你是小说统稿检查员。请阅读本章正文，提取关键信息并以 JSON 返回（不要任何解释，只返回 JSON）：\n{\n  "summary": "本章一句话摘要（≤200字）",\n  "keyEvents": ["关键情节1", "关键情节2"],\n  "charactersInvolved": ["出场角色名"],\n  "newForeshadowings": ["新伏笔"],\n  "resolvedForeshadowings": ["已回收伏笔"],\n  "plotQuestions": ["遗留悬念"],\n  "nextChapterHook": "本章结尾留下的悬念，指向下一章该兑现什么"\}\n\n正文：\n${localContent.slice(0, 6000)}`
      const reply = await chat(checker, [{ role: 'user', content: prompt }])
      let parsed: any = { summary: '', keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: [], plotQuestions: [] }
      try {
        const jsonStr = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
        parsed = { ...parsed, ...JSON.parse(jsonStr) }
      } catch (e) {
        console.warn('Failed to parse checker JSON, fallback to raw summary:', e)
        parsed.summary = reply.slice(0, 200)
      }
      const next = await commitChapterAndSave(novelId, {
        chapterId: selectedChapter.id,
        chapterTitle: selectedChapter.title,
        summary: parsed.summary || '',
        wordCount: wordCount,
        keyEvents: parsed.keyEvents || [],
        charactersInvolved: parsed.charactersInvolved || [],
        newForeshadowings: parsed.newForeshadowings || [],
        resolvedForeshadowings: parsed.resolvedForeshadowings || [],
        plotQuestions: parsed.plotQuestions || [],
        // IMP-03：一并把正文落盘
        content: localContent,
        source: 'manual',
      })
      // 知识库联动：把 checker 产出的 JSON 落入 KB
      try {
        await knowledgeService.applyChapterBrief(novelId, selectedChapter.id, {
          summary: parsed.summary || '',
          keyEvents: parsed.keyEvents || [],
          charactersInvolved: parsed.charactersInvolved || [],
          newForeshadowings: parsed.newForeshadowings || [],
          resolvedForeshadowings: parsed.resolvedForeshadowings || [],
          nextChapterHook: parsed.plotQuestions?.[0] || parsed.nextChapterHook || '',
        })
      } catch (e) {
        console.warn('[finish-chapter] kb apply failed:', e)
      }
      // 完成本章：关键节点强制快照
      createSnapshot(selectedChapter.id, 'finish').catch(() => {})
      setFinishMsg({ ok: true, text: `已更新状态卡（${next.committedChapters.length} 章）` })
      ActionLog.agent('tracking-commit', `${selectedChapter.title}`)
    } catch (e) {
      console.error('Finish chapter failed:', e)
      setFinishMsg({ ok: false, text: `提交失败：${(e as Error).message}` })
    } finally {
      setFinishing(false)
    }
  }, [selectedChapter, localContent, agentConfigs, novelId, wordCount])

  // 卸载时兜底保存（仅真正卸载组件时触发，避免每次按键都即时写盘导致卡顿）
  useEffect(() => {
    return () => {
      flushPendingSave()
      void flushSession(novelId)
    }
  }, [flushPendingSave, novelId])

  // IMP-03：关窗/刷新兜底。debounce 窗口（3 秒）内退出会丢稿，
  // 在 beforeunload 里立即 flush 并向用户确认（Electron 主进程 IPC 通常能在关闭前完成）。
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (latestStateRef.current.dirty) {
        flushPendingSave()
        e.preventDefault()
        e.returnValue = ''
      }
      void flushSession(novelId)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushPendingSave])

  // 在光标处插入 Markdown 语法
  const insertSyntax = useCallback((before: string, after = '', placeholder = '') => {
    const ta = textareaRef.current
    if (!ta) {
      setLocalContent((prev) => prev + before + placeholder + after)
      return
    }
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = localContent.slice(start, end)
    const insertText = before + (selected || placeholder) + after
    const next = localContent.slice(0, start) + insertText + localContent.slice(end)
    handleContentChange(next)
    requestAnimationFrame(() => {
      const pos = selected ? start + insertText.length : start + before.length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    })
  }, [localContent, handleContentChange])

  // Toolbar button component
  const ToolBtn = ({ icon: Icon, label, active, onClick }: {
    icon: typeof Bold
    label: string
    active?: boolean
    onClick?: () => void
  }) => (
    <button
      onClick={onClick}
      className={cn(
        'p-1.5 rounded text-xs transition-colors',
        active ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
      )}
      title={label}
    >
      <Icon size={15} />
    </button>
  )

  const targetWordCount = selectedChapter?.targetWordCount || 3000
  const progress = targetWordCount > 0 ? Math.min(wordCount / targetWordCount, 1) : 0

  // 待处理的编辑建议（未决定态）
  const pendingEdits = editSuggestions.filter((e) => e.accepted == null)

  return (
    <div className="h-full flex flex-col">
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30 bg-sidebar">
        <div className="flex items-center gap-0.5">
          <ToolBtn icon={Bold} label="加粗" onClick={() => insertSyntax('**', '**', '加粗文本')} />
          <ToolBtn icon={Italic} label="斜体" onClick={() => insertSyntax('*', '*', '斜体文本')} />
          <div className="w-px h-4 bg-border/40 mx-1" />
          <ToolBtn icon={Heading1} label="一级标题" onClick={() => insertSyntax('\n# ', '', '标题')} />
          <ToolBtn icon={Heading2} label="二级标题" onClick={() => insertSyntax('\n## ', '', '小标题')} />
          <div className="w-px h-4 bg-border/40 mx-1" />
          <ToolBtn icon={Code} label="代码块" onClick={() => insertSyntax('\n```\n', '\n```\n', '代码')} />
          <div className="w-px h-4 bg-border/40 mx-1" />
          <ToolBtn
            icon={History}
            label="历史版本"
            active={editorDrawer === 'snapshots'}
            onClick={() => setEditorDrawer(editorDrawer === 'snapshots' ? null : 'snapshots')}
          />
          <ToolBtn
            icon={ShieldCheck}
            label="AI 率检测"
            active={editorDrawer === 'ai-rate'}
            onClick={handleAiRateCheck}
          />
          <ToolBtn
            icon={ListTree}
            label="场景卡"
            active={editorDrawer === 'scenes'}
            onClick={() => setEditorDrawer(editorDrawer === 'scenes' ? null : 'scenes')}
          />
          <ToolBtn
            icon={ClipboardList}
            label="状态卡"
            active={editorDrawer === 'state'}
            onClick={() => setEditorDrawer(editorDrawer === 'state' ? null : 'state')}
          />
          <ToolBtn
            icon={Layers}
            label="上下文预览"
            active={editorDrawer === 'context'}
            onClick={() => setEditorDrawer(editorDrawer === 'context' ? null : 'context')}
          />
          <ToolBtn
            icon={ShieldAlert}
            label="连贯性"
            active={editorDrawer === 'continuity'}
            onClick={() => setEditorDrawer(editorDrawer === 'continuity' ? null : 'continuity')}
          />
          <ToolBtn
            icon={Gauge}
            label="文风评估"
            active={editorDrawer === 'style-eval'}
            onClick={() => setEditorDrawer(editorDrawer === 'style-eval' ? null : 'style-eval')}
          />
          <ToolBtn
            icon={BookCheck}
            label="章节评估"
            active={editorDrawer === 'review'}
            onClick={() => setEditorDrawer(editorDrawer === 'review' ? null : 'review')}
          />
          <ToolBtn
            icon={GitCompare}
            label="改稿"
            active={editorDrawer === 'revision'}
            onClick={() => setEditorDrawer(editorDrawer === 'revision' ? null : 'revision')}
          />
        </div>

        {/* View mode toggle */}
        <div className="flex items-center bg-muted/40 rounded-md p-0.5">
          <button
            onClick={() => setEditorMode('edit')}
            className={cn(
              'px-2 py-1 rounded text-xs transition-colors flex items-center gap-1',
              editorMode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            <FileText size={12} />
            编辑
          </button>
          <button
            onClick={() => setEditorMode('preview')}
            className={cn(
              'px-2 py-1 rounded text-xs transition-colors flex items-center gap-1',
              editorMode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            <Eye size={12} />
            预览
          </button>
          <button
            onClick={() => setEditorMode('split')}
            className={cn(
              'px-2 py-1 rounded text-xs transition-colors flex items-center gap-1',
              editorMode === 'split' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            <Columns size={12} />
            分屏
          </button>
        </div>
      </div>

      {/* Chapter Title Bar */}
      <div className="px-4 py-2 border-b border-border/20">
        {editingTitle ? (
          <input
            ref={titleInputRef}
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              const newTitle = titleDraft.trim()
              const chapter = selectedChapter
              // 先关闭编辑态，立即卸载 input（避免 await 期间 input 悬挂导致点击无反应）
              setEditingTitle(false)
              if (chapter && newTitle && newTitle !== chapter.title) {
                chapterService.update(chapter.id, { title: newTitle })
                  .then(() => {
                    // 仅在用户仍停留在该章节时更新标题，避免与章节切换竞态
                    const current = useWorkbenchStore.getState().selectedChapter
                    if (current?.id === chapter.id) {
                      selectChapter({ ...current, title: newTitle })
                    }
                  })
                  .catch((e) => console.error('Failed to rename chapter title:', e))
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') setEditingTitle(false)
            }}
            className="text-sm font-semibold text-foreground bg-muted/40 border border-primary/40 rounded px-1.5 py-0.5 focus:outline-none w-full select-text"
          />
        ) : (
          <h2
            className="text-sm font-semibold text-foreground/70 cursor-text hover:text-foreground transition-colors"
            onClick={() => {
              if (!selectedChapter) return
              setTitleDraft(selectedChapter.title)
              setEditingTitle(true)
            }}
            title="点击重命名章节"
          >
            {selectedChapter?.title || '选择或新建一个章节开始写作'}
          </h2>
        )}
        {selectedChapter && (
          <div className="flex items-center gap-2 ml-3">
            <select
              value={selectedChapter.status}
              onChange={async (e) => {
                const status = e.target.value as Chapter['status']
                try {
                  await chapterService.updateStatus(selectedChapter.id, status)
                  selectChapter({ ...selectedChapter, status })
                } catch (err) {
                  console.error('Failed to update chapter status:', err)
                }
              }}
              className="h-6 rounded-md bg-muted/30 border border-border/60 text-[11px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
              title="章节状态"
            >
              <option value="draft">草稿</option>
              <option value="reviewed">已审</option>
              <option value="polished">精修</option>
              <option value="final">定稿</option>
            </select>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>目标</span>
              <input
                type="number"
                min={0}
                step={500}
                value={selectedChapter.targetWordCount || 3000}
                onChange={async (e) => {
                  const target = Number(e.target.value) || 0
                  try {
                    await chapterService.update(selectedChapter.id, { targetWordCount: target })
                    selectChapter({ ...selectedChapter, targetWordCount: target })
                  } catch (err) {
                    console.error('Failed to update target word count:', err)
                  }
                }}
                className="w-16 h-6 rounded-md bg-muted/30 border border-border/60 text-center text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                title="目标字数"
              />
              <span>字</span>
            </div>
          </div>
        )}
      </div>

      {/* Editor Area */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2">
            <div className="h-6 w-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            <span className="text-xs text-muted-foreground/60">加载章节内容...</span>
          </div>
        </div>
      ) : !selectedChapter ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <FileText size={36} className="text-muted-foreground/15 mb-3" />
          <p className="text-sm text-muted-foreground/50">从左侧章节目录选择一个章节</p>
          <p className="text-xs text-muted-foreground/30 mt-1">或点击 + 创建新章节</p>
        </div>
      ) : (
        <div className={cn(
          'flex-1 flex overflow-hidden',
          editorMode === 'split' && 'divide-x divide-border/20'
        )}>
          {/* Edit Panel */}
          {(editorMode === 'edit' || editorMode === 'split') && (
            <div className={cn(
              'flex-1 flex flex-col overflow-hidden relative',
              editorMode === 'split' ? 'w-1/2' : 'w-full'
            )}>
              <textarea
                ref={textareaRef}
                key={selectedChapter?.id ?? 'no-chapter'}
                value={localContent}
                onChange={(e) => handleContentChange(e.target.value)}
                className={cn(
                  // 关键：用 flex-1 撑满（而非 h-full 百分比），min-h-0 允许收缩，
                  // 使 textarea 成为唯一滚动容器，消除「外层 overflow-y-auto + 内层滚动」两层滚动。
                  'w-full flex-1 min-h-0 p-6',
                  'bg-transparent resize-none overflow-y-auto overscroll-none',
                  'font-mono text-sm leading-relaxed',
                  'text-foreground placeholder:text-muted-foreground/40',
                  'focus:outline-none',
                  // 关键：父级 select-none 会禁用文本选择导致光标不显示，显式恢复
                  'select-text',
                )}
                placeholder="在此开始书写..."
                spellCheck={false}
              />

              {/* 内联编辑建议浮层（在编辑区右下角） */}
              {pendingEdits.length > 0 && (
                <div className="absolute bottom-3 right-3 left-3 max-h-[45%] overflow-y-auto space-y-1.5 z-10 animate-fade-in pointer-events-none">
                  <div className="flex items-center gap-1.5 mb-1 px-1 pointer-events-auto">
                    <Sparkles size={11} className="text-primary" />
                    <span className="text-[10px] font-medium text-primary/80 uppercase tracking-wider">
                      AI 编辑建议 ({pendingEdits.length})
                    </span>
                    <button
                      onClick={clearEditSuggestions}
                      className="ml-auto text-[9px] text-muted-foreground/50 hover:text-red-400 transition-colors"
                      title="清除所有建议"
                    >
                      清除
                    </button>
                  </div>
                  {pendingEdits.map((edit) => (
                    <div
                      key={edit.id}
                      className="border border-primary/20 bg-sidebar/95 backdrop-blur-sm rounded-lg p-2.5 shadow-lg pointer-events-auto"
                    >
                      {edit.reason && (
                        <div className="text-[10px] text-primary/70 italic mb-1">{edit.reason}</div>
                      )}
                      <div className="bg-red-500/8 text-red-300/90 rounded px-2 py-1 font-mono text-[11px] line-through decoration-red-400/40 leading-relaxed max-h-16 overflow-y-auto">
                        {edit.original}
                      </div>
                      <div className="my-1 flex justify-center">
                        <svg width="12" height="8" viewBox="0 0 12 8" fill="none"><path d="M1 7L6 2L11 7" stroke="currentColor" strokeWidth="1.5" className="text-primary/40"/></svg>
                      </div>
                      <div className="bg-green-500/8 text-green-300/90 rounded px-2 py-1 font-mono text-[11px] leading-relaxed max-h-16 overflow-y-auto">
                        {edit.replacement}
                      </div>
                      <div className="flex gap-1.5 mt-1.5 pt-1 border-t border-border/10">
                        <button
                          onClick={() => handleAcceptEdit(edit)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-500/15 text-green-400 hover:bg-green-500/25 text-[10px] transition-colors"
                        >
                          <Check size={10} /> Accept
                        </button>
                        <button
                          onClick={() => handleRejectEdit(edit.id)}
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 text-[10px] transition-colors"
                        >
                          <X size={10} /> Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Preview Panel */}
          {(editorMode === 'preview' || editorMode === 'split') && (
            <div className={cn(
              'flex-1 overflow-y-auto p-6',
              editorMode === 'split' ? 'w-1/2' : 'w-full',
              'bg-muted/30'
            )}>
              <MarkdownPreview content={localContent || '_暂无内容_' } />
            </div>
          )}
        </div>
      )}

      {/* Status bar */}
      <div className="px-4 py-1.5 border-t border-border/20 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <div className={cn(
            'w-1.5 h-1.5 rounded-full',
            isDirty ? 'bg-yellow-400' : 'bg-green-400'
          )} />
          {isDirty ? '未保存' : '已保存'}
          {pendingEdits.length > 0 && (
            <span className="text-primary/70 ml-1">
              · {pendingEdits.length} 条待处理建议
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>目标: {targetWordCount.toLocaleString()} 字</span>
          <span className={cn(
            wordCount >= targetWordCount ? 'text-green-400' : 'text-yellow-400'
          )}>
            当前: {wordCount.toLocaleString()} 字
          </span>
          {selectedChapter && (
            <div className="w-20 h-1 rounded-full bg-muted/40 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  progress >= 1 ? 'bg-green-400' : progress >= 0.5 ? 'bg-yellow-400' : 'bg-primary/60'
                )}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}
          {selectedChapter && continuityWarn?.chapterId === selectedChapter.id &&
            (continuityWarn.blocking > 0 || continuityWarn.warnings > 0) && (
            <button
              onClick={() => setEditorDrawer('continuity')}
              title="打开连贯性检查"
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors',
                continuityWarn.blocking > 0
                  ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                  : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
              )}
            >
              <ShieldAlert size={10} />
              {continuityWarn.blocking > 0
                ? `连贯性 ${continuityWarn.blocking} 处硬伤`
                : `连贯性 ${continuityWarn.warnings} 条提示`}
            </button>
          )}
          {finishMsg && (
            <span className={finishMsg.ok ? 'text-green-400' : 'text-red-400'}>
              {finishMsg.text}
            </span>
          )}
          {saveMsg && (
            <span className={cn('flex items-center gap-1.5', saveMsg.ok ? 'text-green-400' : 'text-red-400')}>
              <span>{saveMsg.text}</span>
              {saveMsg.retry && (
                <button
                  onClick={() => void handleRetrySave()}
                  className="px-1.5 py-0.5 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 text-[10px] transition-colors"
                >
                  重试
                </button>
              )}
            </span>
          )}
          {selectedChapter && (
            <button
              onClick={handleFinishChapter}
              disabled={finishing || !localContent.trim()}
              className={cn(
                'px-2.5 py-0.5 rounded-md text-[10px] transition-colors',
                finishing
                  ? 'bg-primary/20 text-primary/70 cursor-wait'
                  : 'bg-primary/15 text-primary hover:bg-primary/25 cursor-pointer'
              )}
            >
              {finishing ? '分析中…' : '完成本章'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Markdown Preview (react-markdown, 防 XSS)
function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none font-serif text-[15px] leading-relaxed
      [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h1]:text-foreground
      [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:my-4 [&_h2]:text-foreground
      [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-3 [&_h3]:text-foreground
      [&_p]:my-2 [&_p]:text-foreground/80
      [&_strong]:font-semibold [&_strong]:text-foreground
      [&_em]:italic [&_em]:text-foreground/80
      [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:my-2 [&_blockquote]:text-muted-foreground [&_blockquote]:italic
      [&_ul]:list-disc [&_ul]:ml-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:my-2
      [&_li]:text-foreground/80
      [&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:text-primary
      [&_pre]:bg-muted/30 [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content || '_暂无内容_'}
      </ReactMarkdown>
    </div>
  )
}
