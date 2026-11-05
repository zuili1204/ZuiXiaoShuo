import { create } from 'zustand'
import { getSetting, setSetting } from '@/services/settings-service'
import { agentConfigService } from '@/services/data-service'
import { DEFAULT_AGENT_CONFIGS } from '@shared/constants'
import type { AgentConfig } from '@shared/types'

export type ThemeMode = 'dark' | 'light'

interface SettingsState {
  theme: ThemeMode
  dataPath: string
  // 工作台布局
  leftCollapsed: boolean
  rightCollapsed: boolean
  editorMode: 'edit' | 'preview' | 'split'
  fontSize: number
  // 自动保存间隔（秒）
  autoSaveInterval: number
  // 运行时标记
  hydrated: boolean

  // Agent 配置
  agentConfigs: AgentConfig[]

  setTheme: (theme: ThemeMode) => void
  setDataPath: (path: string) => void
  togglePanel: (panel: 'left' | 'right') => void
  setEditorMode: (mode: 'edit' | 'preview' | 'split') => void
  setFontSize: (size: number) => void
  setAutoSaveInterval: (sec: number) => void
  hydrate: () => Promise<void>
  resetToDefaults: () => void

  // Agent 配置管理（自动落库）
  updateAgentConfig: (id: string, patch: Partial<AgentConfig>) => void
  addAgentConfig: (config: AgentConfig) => void
  removeAgentConfig: (id: string) => void
}

const DEFAULTS = {
  theme: 'dark' as ThemeMode,
  dataPath: '',
  leftCollapsed: false,
  rightCollapsed: false,
  editorMode: 'split' as const,
  fontSize: 16,
  autoSaveInterval: 5,
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  agentConfigs: [],

  setTheme: (theme) => {
    set({ theme })
    setSetting('theme', theme)
    applyTheme(theme)
  },

  setDataPath: (path) => {
    set({ dataPath: path })
    setSetting('dataPath', path)
  },

  togglePanel: (panel) => {
    if (panel === 'left') {
      const next = !get().leftCollapsed
      set({ leftCollapsed: next })
      setSetting('layout.leftCollapsed', next)
    } else {
      const next = !get().rightCollapsed
      set({ rightCollapsed: next })
      setSetting('layout.rightCollapsed', next)
    }
  },

  setEditorMode: (mode) => {
    set({ editorMode: mode })
    setSetting('layout.editorMode', mode)
  },

  setFontSize: (size) => {
    set({ fontSize: size })
    setSetting('appearance.fontSize', size)
  },

  setAutoSaveInterval: (sec) => {
    set({ autoSaveInterval: sec })
    setSetting('autosave.interval', sec)
  },

  hydrate: async () => {
    const [theme, dataPath, left, right, mode, fontSize, autoSave] = await Promise.all([
      getSetting<ThemeMode>('theme', DEFAULTS.theme),
      getSetting<string>('dataPath', DEFAULTS.dataPath),
      getSetting<boolean>('layout.leftCollapsed', DEFAULTS.leftCollapsed),
      getSetting<boolean>('layout.rightCollapsed', DEFAULTS.rightCollapsed),
      getSetting<'edit' | 'preview' | 'split'>('layout.editorMode', DEFAULTS.editorMode),
      getSetting<number>('appearance.fontSize', DEFAULTS.fontSize),
      getSetting<number>('autosave.interval', DEFAULTS.autoSaveInterval),
    ])
    let agentConfigs: AgentConfig[] = []
    try {
      agentConfigs = await agentConfigService.getAll()
      // 首启：若无任何 agent 配置，写入内置默认（架构师/作家/润色/统稿）
      if (agentConfigs.length === 0) {
        for (const cfg of DEFAULT_AGENT_CONFIGS) {
          await agentConfigService.save({
            ...cfg,
            id: `agent-${cfg.role}-default`,
          } as AgentConfig)
        }
        agentConfigs = await agentConfigService.getAll()
      }
    } catch (e) {
      console.error('Failed to load agent configs during hydrate:', e)
    }
    set({
      theme,
      dataPath,
      leftCollapsed: left,
      rightCollapsed: right,
      editorMode: mode,
      fontSize,
      autoSaveInterval: autoSave,
      agentConfigs,
      hydrated: true,
    })
    applyTheme(theme)
  },

  resetToDefaults: () => {
    set({ ...DEFAULTS })
    setSetting('theme', DEFAULTS.theme)
    setSetting('dataPath', DEFAULTS.dataPath)
    setSetting('layout.leftCollapsed', DEFAULTS.leftCollapsed)
    setSetting('layout.rightCollapsed', DEFAULTS.rightCollapsed)
    setSetting('layout.editorMode', DEFAULTS.editorMode)
    setSetting('appearance.fontSize', DEFAULTS.fontSize)
    setSetting('autosave.interval', DEFAULTS.autoSaveInterval)
    applyTheme(DEFAULTS.theme)
  },

  updateAgentConfig: (id, patch) => {
    set((state) => {
      const agentConfigs = state.agentConfigs.map((c) =>
        c.id === id ? { ...c, ...patch } : c
      )
      return { agentConfigs }
    })
    const updated = get().agentConfigs.find((c) => c.id === id)
    if (updated) agentConfigService.save(updated)
  },

  addAgentConfig: (config) => {
    set((state) => ({ agentConfigs: [...state.agentConfigs, config] }))
    agentConfigService.save(config)
  },

  removeAgentConfig: (id) => {
    set((state) => ({ agentConfigs: state.agentConfigs.filter((c) => c.id !== id) }))
    agentConfigService.delete(id)
  },
}))

// 将主题应用到 document，供全局样式读取
function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // 移除遗留的主题类，避免 index.html 自带 class="dark" 与 theme-* 类相互叠加
  root.classList.remove('theme-dark', 'theme-light', 'dark')
  if (theme === 'dark') {
    // Tailwind darkMode:'class' 与 .dark/.theme-dark 变量均依赖此 class
    root.classList.add('dark')
  }
  root.dataset.theme = theme
}
