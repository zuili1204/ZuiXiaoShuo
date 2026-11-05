import { appendFileSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB 轮转上限
const KEEP_TAIL = 512 * 1024 // 轮转后保留的末尾字节数

// 日志级别：DEBUG < INFO < WARN < ERROR
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

/** 将任意值安全序列化为可读文本（Error 对象含 stack，对象转 JSON，超长截断） */
function stringify(value: unknown, maxLen = 2000): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (value instanceof Error) {
    const msg = `${value.name}: ${value.message}`
    const stack = value.stack ? value.stack.split('\n').slice(0, 8).join(' ← ') : ''
    return stack ? `${msg} | ${stack}` : msg
  }
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value, null, 0)
    return json.length > maxLen ? json.slice(0, maxLen) + '…(截断)' : json
  } catch {
    return String(value)
  }
}

class ActionLogger {
  private logPaths: string[] = []
  private sessionStart = ''
  private minLevel: LogLevel = 'DEBUG'

  /** 支持同时写入多个路径（开发期可同时写到 userData 与项目根目录） */
  init(paths: string | string[], minLevel: LogLevel = 'DEBUG') {
    this.logPaths = Array.isArray(paths) ? paths : [paths]
    this.sessionStart = new Date().toISOString()
    this.minLevel = minLevel
    const sep = `\n${'='.repeat(60)}\n新会话启动: ${this.sessionStart}\n${'='.repeat(60)}\n`
    for (const p of this.logPaths) {
      try {
        if (!existsSync(p)) {
          writeFileSync(p, this.header(), 'utf-8')
        } else {
          appendFileSync(p, sep, 'utf-8')
        }
      } catch {
        // 忽略单个路径初始化失败
      }
    }
  }

  private header(): string {
    return (
      `================================================================\n` +
      `醉小说 运行日志 (log.txt)\n` +
      `说明: 实时记录用户操作、AI 指令、操作结果与错误，便于回溯与修复。\n` +
      `级别: DEBUG < INFO < WARN < ERROR（错误含堆栈）\n` +
      `格式: [时间戳] [级别] [分类] 操作 - 详情\n` +
      `================================================================\n` +
      `会话启动: ${this.sessionStart}\n`
    )
  }

  /** 核心写入：按级别写入一行 */
  private writeLine(level: LogLevel, category: string, action: string, detail?: unknown) {
    if (this.logPaths.length === 0) return
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return
    const ts = new Date().toISOString()
    const detailStr = detail === undefined ? '' : stringify(detail)
    const line = detailStr
      ? `[${ts}] [${level}] [${category}] ${action} - ${detailStr}\n`
      : `[${ts}] [${level}] [${category}] ${action}\n`
    for (const p of this.logPaths) {
      try {
        if (existsSync(p) && statSync(p).size > MAX_SIZE) {
          const content = readFileSync(p, 'utf-8')
          writeFileSync(p, content.slice(-KEEP_TAIL), 'utf-8')
        }
        appendFileSync(p, line, 'utf-8')
      } catch {
        // 忽略单个路径写入失败，不阻塞主流程
      }
    }
  }

  /** INFO：常规操作与结果 */
  log(category: string, action: string, detail?: unknown) {
    this.writeLine('INFO', category, action, detail)
  }

  /** DEBUG：细粒度调试信息 */
  debug(category: string, action: string, detail?: unknown) {
    this.writeLine('DEBUG', category, action, detail)
  }

  /** WARN：可恢复的异常/降级 */
  warn(category: string, action: string, detail?: unknown) {
    this.writeLine('WARN', category, action, detail)
  }

  /** ERROR：错误/异常（Error 对象自动带堆栈） */
  error(category: string, action: string, detail?: unknown) {
    this.writeLine('ERROR', category, action, detail)
  }

  getPaths(): string[] {
    return this.logPaths
  }
}

export const actionLogger = new ActionLogger()

/**
 * 安装主进程全局异常捕获：
 * - uncaughtException / unhandledRejection → 写入 ERROR 日志，避免静默崩溃
 */
export function installGlobalErrorHandlers() {
  process.on('uncaughtException', (err) => {
    actionLogger.error('MAIN', 'uncaughtException', err)
    console.error('[uncaughtException]', err)
  })
  process.on('unhandledRejection', (reason) => {
    actionLogger.error('MAIN', 'unhandledRejection', reason)
    console.error('[unhandledRejection]', reason)
  })
}
