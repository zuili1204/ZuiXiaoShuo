import { create } from 'zustand'
import type { Chapter, QualityGate } from '@shared/types'
import { countWords } from '@/utils/charcount'
import { getSetting, setSetting } from '@/services/settings-service'
import { runQualityGate } from '@/services/quality-service'

export interface EditSuggestion {
  id: string
  original: string
  replacement: string
  reason: string
  accepted?: boolean | null // null = pending, true = accepted, false = rejected
}

export interface ThinkingStep {
  id: string
  content: string
  timestamp: number
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheRead?: number
  cacheWrite?: number
  thinkingTokens?: number
  model?: string
  timestamp?: number
}

// 编辑器工具抽屉视图：null = 关闭；同一容器内切换内容（历史版本 / AI 率检测 / 场景卡 / 状态卡 / 上下文预览）
export type EditorDrawerView = 'snapshots' | 'ai-rate' | 'scenes' | 'state' | 'context' | 'continuity' | 'style-eval' | 'review' | 'revision'

/** 外部（场景面板等）回写编辑器正文的信号；带章节号防止串章 */
export interface ExternalEditorEdit {
  chapterId: string
  content: string
  nonce: number
}

interface WorkbenchStore {
  // Layout state
  leftPanelWidth: number
  rightPanelWidth: number
  isLeftCollapsed: boolean
  isRightCollapsed: boolean

  // Selection state
  selectedChapter: Chapter | null
  selectedVolumeId: string | null

  // Editor state
  editorContent: string
  editorMode: 'edit' | 'preview' | 'split'
  isDirty: boolean
  wordCount: number
  editorReloadKey: number

  // Craft mode: inline edit suggestions (shared between AiChatPanel & WritingEditor)
  editSuggestions: EditSuggestion[]
  // Thinking chain from agent
  thinkingSteps: ThinkingStep[]
  // Token usage history
  tokenUsageHistory: TokenUsage[]

  // Chat state
  activeAgentId: string | null
  pipelineConfigId: string | null

  // P0：质量门禁状态卡
  qualityGate: QualityGate | null
  qualityChecking: boolean

  // F2：手动「AI 率检测」报告（与保存钩子的 qualityGate 分离，避免互相覆盖）
  // 报告按章节绑定，切章自动失效；检测中的 loading / 错误也集中在此，供工具栏与抽屉共用
  aiReportGate: QualityGate | null
  aiReportChapterId: string | null
  aiReportChecking: boolean
  aiReportError: string | null

  // P1 UI：技能面板注入到对话的暂存指令
  pendingSkillInject: string | null

  // 编辑器工具抽屉（历史版本 / AI 率检测 / 场景卡共用容器）
  editorDrawer: EditorDrawerView | null
  // 外部回写编辑器正文（场景卡生成/标记插入），由 WritingEditor 落进本地缓冲并触发出保存
  externalEditorEdit: ExternalEditorEdit | null

  // Layout actions
  setLeftPanelWidth: (w: number) => void
  setRightPanelWidth: (w: number) => void
  toggleLeftCollapsed: () => void
  toggleRightCollapsed: () => void

  // Selection actions
  selectChapter: (chapter: Chapter | null) => void
  setSelectedVolumeId: (id: string | null) => void

  // Editor actions
  setEditorContent: (content: string) => void
  setEditorMode: (mode: 'edit' | 'preview' | 'split') => void
  setDirty: (dirty: boolean) => void
  setWordCount: (count: number) => void
  reloadEditor: () => void

  // Edit suggestion actions (craft mode)
  setEditSuggestions: (suggestions: EditSuggestion[]) => void
  acceptEditSuggestion: (id: string) => void
  rejectEditSuggestion: (id: string) => void
  clearEditSuggestions: () => void

  // Thinking chain actions
  addThinkingStep: (content: string) => void
  clearThinkingSteps: () => void

  // Token usage actions
  addTokenUsage: (usage: TokenUsage) => void
  clearTokenUsage: () => void

  // Chat actions
  setActiveAgentId: (agentId: string | null) => void
  setPipelineConfigId: (configId: string | null) => void

  // Quality gate actions
  setQualityGate: (q: QualityGate | null) => void
  setQualityChecking: (v: boolean) => void
  runAiReportCheck: () => Promise<void>
  clearAiReport: () => void
  setPendingSkillInject: (v: string | null) => void
  setEditorDrawer: (v: EditorDrawerView | null) => void
  applyEditorContent: (chapterId: string, content: string) => void

  // P2-8：布局记忆——启动时从 settings 表恢复面板宽度/折叠状态
  hydrateLayout: () => Promise<void>
}

// ===== P2-8：布局持久化（settings 表） =====
// 宽度拖拽高频触发，防抖落库；折叠切换低频，立即落库。
let widthSaveTimer: ReturnType<typeof setTimeout> | null = null
function persistWidth(key: 'layout.leftPanelWidth' | 'layout.rightPanelWidth', value: number) {
  if (widthSaveTimer) clearTimeout(widthSaveTimer)
  widthSaveTimer = setTimeout(() => {
    widthSaveTimer = null
    void setSetting(key, value)
  }, 400)
}

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  leftPanelWidth: 280,
  rightPanelWidth: 380,
  isLeftCollapsed: false,
  isRightCollapsed: false,

  selectedChapter: null,
  selectedVolumeId: null,

  editorContent: '',
  editorMode: 'edit',
  isDirty: false,
  wordCount: 0,
  pendingSkillInject: null,
  editorReloadKey: 0,

  editSuggestions: [],
  thinkingSteps: [],
  tokenUsageHistory: [],

  activeAgentId: null,
  pipelineConfigId: null,
  editorDrawer: null,
  externalEditorEdit: null,

  qualityGate: null,
  qualityChecking: false,
  aiReportGate: null,
  aiReportChapterId: null,
  aiReportChecking: false,
  aiReportError: null,

  setLeftPanelWidth: (w) => {
    const clamped = Math.max(200, Math.min(w, 500))
    set({ leftPanelWidth: clamped })
    persistWidth('layout.leftPanelWidth', clamped)
  },
  setRightPanelWidth: (w) => {
    const clamped = Math.max(300, Math.min(w, 600))
    set({ rightPanelWidth: clamped })
    persistWidth('layout.rightPanelWidth', clamped)
  },
  toggleLeftCollapsed: () =>
    set((s) => {
      const isLeftCollapsed = !s.isLeftCollapsed
      void setSetting('layout.leftCollapsed', isLeftCollapsed)
      return { isLeftCollapsed }
    }),
  toggleRightCollapsed: () =>
    set((s) => {
      const isRightCollapsed = !s.isRightCollapsed
      void setSetting('layout.rightCollapsed', isRightCollapsed)
      return { isRightCollapsed }
    }),

  // P2-8：启动恢复（读取失败时保持默认值，静默降级）
  hydrateLayout: async () => {
    try {
      const [lw, rw, lc, rc] = await Promise.all([
        getSetting<number>('layout.leftPanelWidth', 280),
        getSetting<number>('layout.rightPanelWidth', 380),
        getSetting<boolean>('layout.leftCollapsed', false),
        getSetting<boolean>('layout.rightCollapsed', false),
      ])
      set({
        leftPanelWidth: Math.max(200, Math.min(lw, 500)),
        rightPanelWidth: Math.max(300, Math.min(rw, 600)),
        isLeftCollapsed: lc,
        isRightCollapsed: rc,
      })
    } catch (e) {
      console.error('hydrateLayout failed:', e)
    }
  },

  // 切章即作废旧章节的 AI 率报告；标题重命名等同一章节更新不清空
  selectChapter: (chapter) =>
    set((s) => {
      if ((chapter?.id ?? null) === (s.selectedChapter?.id ?? null)) {
        return { selectedChapter: chapter }
      }
      return {
        selectedChapter: chapter,
        aiReportGate: null,
        aiReportChapterId: null,
        aiReportChecking: false,
        aiReportError: null,
      }
    }),
  setSelectedVolumeId: (id) => set({ selectedVolumeId: id }),

  // 注意：setEditorContent 只镜像内容与字数，不再强制 isDirty。
  // isDirty 由 WritingEditor 显式管理（加载=false，编辑=true，保存成功=false），
  // 避免加载章节时 setEditorContent 把 isDirty 误置为 true 造成抖动。
  setEditorContent: (content) =>
    set({ editorContent: content, wordCount: countWords(content) }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setWordCount: (count) => set({ wordCount: count }),
  reloadEditor: () => set((s) => ({ editorReloadKey: s.editorReloadKey + 1 })),

  // Edit suggestions (craft mode)
  setEditSuggestions: (suggestions) => set({ editSuggestions: suggestions }),
  acceptEditSuggestion: (id) =>
    set((s) => ({
      editSuggestions: s.editSuggestions.map((e) =>
        e.id === id ? { ...e, accepted: true } : e
      ),
    })),
  rejectEditSuggestion: (id) =>
    set((s) => ({
      editSuggestions: s.editSuggestions.map((e) =>
        e.id === id ? { ...e, accepted: false } : e
      ),
    })),
  clearEditSuggestions: () => set({ editSuggestions: [] }),

  // Thinking chain
  addThinkingStep: (content) =>
    set((s) => ({
      thinkingSteps: [
        ...s.thinkingSteps,
        { id: `think-${Date.now()}`, content, timestamp: Date.now() },
      ],
    })),
  clearThinkingSteps: () => set({ thinkingSteps: [] }),

  // Token usage
  addTokenUsage: (usage) =>
    set((s) => ({
      tokenUsageHistory: [...s.tokenUsageHistory, usage],
    })),
  clearTokenUsage: () => set({ tokenUsageHistory: [] }),

  setActiveAgentId: (agentId) => set({ activeAgentId: agentId }),
  setPipelineConfigId: (configId) => set({ pipelineConfigId: configId }),

  setQualityGate: (q) => set({ qualityGate: q }),
  setQualityChecking: (v) => set({ qualityChecking: v }),

  // 手动 AI 率检测：工具栏与抽屉共用同一入口，避免两套 loading/错误状态。
  // 结果只在发起检测的章节仍被选中时落库，切章途中返回的旧结果直接丢弃。
  runAiReportCheck: async () => {
    const { selectedChapter, editorContent, aiReportChecking } = get()
    if (aiReportChecking) return
    const chapterId = selectedChapter?.id ?? null
    set({ aiReportChecking: true, aiReportError: null })
    try {
      const gate = await runQualityGate(editorContent)
      if ((get().selectedChapter?.id ?? null) !== chapterId) return
      set({ aiReportGate: gate, aiReportChapterId: chapterId, aiReportChecking: false })
    } catch (e) {
      if ((get().selectedChapter?.id ?? null) !== chapterId) return
      set({
        aiReportChecking: false,
        aiReportError: (e as Error)?.message || '检测失败',
      })
    }
  },
  clearAiReport: () =>
    set({ aiReportGate: null, aiReportChapterId: null, aiReportChecking: false, aiReportError: null }),

  setPendingSkillInject: (v) => set({ pendingSkillInject: v }),
  setEditorDrawer: (v) => set({ editorDrawer: v }),
  applyEditorContent: (chapterId, content) =>
    set((s) => ({
      editorContent: content,
      wordCount: countWords(content),
      externalEditorEdit: {
        chapterId,
        content,
        nonce: (s.externalEditorEdit?.nonce ?? 0) + 1,
      },
    })),
}))
