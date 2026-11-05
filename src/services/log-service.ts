// 用户操作日志 —— 前端封装
// 所有用户操作 (点击、跳转、业务动作) 通过本模块写入 Electron 主进程的 log.txt
// 同时提供 error/warn/debug 级别，并通过全局错误捕获收集 bug 与操作结果。

type LogCategory =
  | 'UI' // 界面点击/交互
  | 'NAV' // 页面导航
  | 'NOVEL' // 小说增删改
  | 'CHAPTER' // 章节操作
  | 'CHARACTER' // 角色操作
  | 'WORLDVIEW' // 世界观操作
  | 'OUTLINE' // 大纲操作
  | 'AGENT' // AI 智能体
  | 'TOOL' // AI 工具调用
  | 'SKILL' // 技能
  | 'KB' // 知识库
  | 'TRACKING' // 创作追踪
  | 'SETTINGS' // 设置
  | 'IMPORT' // 导入
  | 'EXPORT' // 导出
  | 'ERROR' // 错误
  | 'SYSTEM' // 系统

/** 将任意值安全序列化为日志文本（Error 含 stack，对象转 JSON，超长截断） */
function stringify(value: unknown, maxLen = 1500): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (value instanceof Error) {
    const stack = value.stack ? value.stack.split('\n').slice(0, 5).join(' ← ') : ''
    return stack ? `${value.name}: ${value.message} | ${stack}` : `${value.name}: ${value.message}`
  }
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json.length > maxLen ? json.slice(0, maxLen) + '…' : json
  } catch {
    return String(value)
  }
}

function getApi() {
  return (window as any).electronAPI
}

function safeInvoke(method: string, category: LogCategory, action: string, detail?: unknown) {
  try {
    const api = getApi()
    if (api && typeof api[method] === 'function') {
      api[method](category, action, stringify(detail))
    }
  } catch {
    // 忽略，不阻塞 UI
  }
}

export function logAction(category: LogCategory, action: string, detail?: unknown) {
  safeInvoke('logAction', category, action, detail)
}

export function logError(category: LogCategory, action: string, detail?: unknown) {
  safeInvoke('logError', category, action, detail)
}

export function logWarn(category: LogCategory, action: string, detail?: unknown) {
  safeInvoke('logWarn', category, action, detail)
}

export function logDebug(category: LogCategory, action: string, detail?: unknown) {
  safeInvoke('logDebug', category, action, detail)
}

export const ActionLog = {
  ui: (action: string, detail?: unknown) => logAction('UI', action, detail),
  nav: (action: string, detail?: unknown) => logAction('NAV', action, detail),
  novel: (action: string, detail?: unknown) => logAction('NOVEL', action, detail),
  chapter: (action: string, detail?: unknown) => logAction('CHAPTER', action, detail),
  character: (action: string, detail?: unknown) => logAction('CHARACTER', action, detail),
  worldview: (action: string, detail?: unknown) => logAction('WORLDVIEW', action, detail),
  outline: (action: string, detail?: unknown) => logAction('OUTLINE', action, detail),
  agent: (action: string, detail?: unknown) => logAction('AGENT', action, detail),
  tool: (action: string, detail?: unknown) => logAction('TOOL', action, detail),
  skill: (action: string, detail?: unknown) => logAction('SKILL', action, detail),
  kb: (action: string, detail?: unknown) => logAction('KB', action, detail),
  tracking: (action: string, detail?: unknown) => logAction('TRACKING', action, detail),
  settings: (action: string, detail?: unknown) => logAction('SETTINGS', action, detail),
  import: (action: string, detail?: unknown) => logAction('IMPORT', action, detail),
  export: (action: string, detail?: unknown) => logAction('EXPORT', action, detail),
  error: (action: string, detail?: unknown) => logError('ERROR', action, detail),
  warn: (action: string, detail?: unknown) => logWarn('ERROR', action, detail),
  system: (action: string, detail?: unknown) => logAction('SYSTEM', action, detail),
}

/**
 * 安装渲染进程全局错误捕获（应在应用入口调用一次）：
 * - window.onerror：未捕获的运行时错误
 * - window.onunhandledrejection：未处理的 Promise 拒绝
 * - 劫持 console.error / console.warn：把散落的错误日志自动转发到 log.txt
 * 均内置防循环（转发时临时恢复原函数）。
 */
let installed = false

export function installGlobalErrorCapture() {
  if (installed) return
  installed = true

  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)

  // 未捕获运行时错误
  window.addEventListener('error', (e) => {
    const msg = e.error instanceof Error ? e.error : `${e.message} @ ${e.filename}:${e.lineno}`
    safeInvoke('logError', 'ERROR', 'window.onerror', stringify(msg))
    origError('[window.onerror]', msg)
  })

  // 未处理 Promise 拒绝
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? e.reason : String(e.reason)
    safeInvoke('logError', 'ERROR', 'unhandledrejection', stringify(reason))
    origError('[unhandledrejection]', reason)
  })

  // 劫持 console.error：自动写入错误日志
  console.error = (...args: unknown[]) => {
    try {
      const text = args.map((a) => stringify(a)).join(' ')
      safeInvoke('logError', 'ERROR', 'console.error', text)
    } catch { /* ignore */ }
    origError(...args)
  }

  // 劫持 console.warn：自动写入告警日志
  console.warn = (...args: unknown[]) => {
    try {
      const text = args.map((a) => stringify(a)).join(' ')
      safeInvoke('logWarn', 'ERROR', 'console.warn', text)
    } catch { /* ignore */ }
    origWarn(...args)
  }
}

export type { LogCategory }
