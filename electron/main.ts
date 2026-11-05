import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron'
import { join, isAbsolute } from 'path'
import { initDatabase, getDatabase } from './services/db-service'
import { fileService } from './services/file-service'
import { actionLogger, installGlobalErrorHandlers } from './services/logger'
import { encryptKey, decryptKey } from './services/key-service'
import { skillVault } from './services/skill-vault'
import { checkQuality } from './services/quality-checker'
import { checkPlanHealth, validatePlanProposal, type PlanHealthInput, type PlanValidationInput } from './services/plan-validator'
import { CorpusService } from './services/corpus-service'
import { computeStyleMetrics } from '../shared/style-metrics'

const corpusService = new CorpusService(fileService)

process.env.DIST_ELECTRON = join(__dirname)
process.env.DIST = join(process.env.DIST_ELECTRON, '../dist')
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST

// 开发模式开启 CDP 调试端口，便于自动化测试 (仅 dev)
// 注意：只有 VITE_DEV_SERVER_URL 存在才是真正的开发模式；生产构建不开启调试端口。
if (process.env.VITE_DEV_SERVER_URL) {
  try { app.commandLine.appendSwitch('remote-debugging-port', '9222') } catch {}
}

// E2E 隔离钩子：设置 ZXS_USER_DATA_DIR 时将 userData 指向独立目录，
// 避免自动化测试读写真实用户数据（必须在 ready 前调用）
if (process.env.ZXS_USER_DATA_DIR) {
  app.setPath('userData', process.env.ZXS_USER_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

function createWindow() {
  mainWindow = new BrowserWindow({
    title: '醉小说',
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0b',
    show: false,
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../resources/icons/icon.ico') }),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 注入 Content-Security-Policy，消除 Electron 不安全内容策略告警
  const isDev = !!VITE_DEV_SERVER_URL
  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ws: wss: https:; frame-src 'none'; object-src 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https:; frame-src 'none'; object-src 'none'"
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(process.env.DIST!, 'index.html'))
  }
}

// IPC: Window controls
function registerIpcHandlers() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized())

  // Dialog operations
  ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt', 'md'] },
        { name: '表格文件', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:selectDirectory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:saveFile', async (_event, defaultName?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown 文件', extensions: ['md'] },
        { name: '文本文件', extensions: ['txt'] },
        { name: 'Word 文档', extensions: ['docx'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? null : result.filePath
  })

  // File operations
  ipcMain.handle('file:read', (_event, filePath: string) => {
    return fileService.readFile(filePath)
  })

  // 技能内容只从保险库按文件键读取；同步通道供渲染层在模块初始化时注入 prompt。
  ipcMain.on('skill:read-file', (event, relKey: string) => {
    event.returnValue = skillVault.read(relKey)
  })
  ipcMain.handle('file:write', (_event, filePath: string, content: string) => {
    return fileService.writeFile(filePath, content)
  })
  ipcMain.handle('file:write-base64', (_event, filePath: string, base64: string) => {
    return fileService.writeFileBase64(filePath, base64)
  })
  ipcMain.handle('file:delete', (_event, filePath: string) => {
    return fileService.deleteFile(filePath)
  })
  ipcMain.handle('file:delete-dir', (_event, dirPath: string) => {
    return fileService.deleteDir(dirPath)
  })
  ipcMain.handle('file:rename', (_event, fromPath: string, toPath: string) => {
    return fileService.renameFile(fromPath, toPath)
  })
  ipcMain.handle('file:list', (_event, dirPath: string) => {
    return fileService.listFiles(dirPath)
  })
  ipcMain.handle('file:exists', (_event, filePath: string) => {
    return fileService.exists(filePath)
  })
  ipcMain.handle('file:mkdir', (_event, dirPath: string) => {
    return fileService.mkdir(dirPath)
  })

  // P2：文风语料与相似度（LLM 分析仍在渲染层，主进程只做文件与确定性计算）
  ipcMain.handle('corpus:preview', (_event, input: { path?: string; kind: string; text?: string }) =>
    corpusService.preview(input as never),
  )
  ipcMain.handle(
    'corpus:import',
    (_event, input: { sourceId: string; name: string; path?: string; kind: string; text?: string }) =>
      corpusService.import(input as never),
  )
  ipcMain.handle('corpus:delete', (_event, sourceId: string) => corpusService.delete(sourceId))
  ipcMain.handle('style:metrics', (_event, text: string) => computeStyleMetrics(String(text ?? '')))
  ipcMain.handle(
    'style:similarity',
    (_event, input: { text: string; sourceIds?: string[]; entities?: string[] }) =>
      corpusService.similarity(input ?? { text: '' }),
  )

  // 数据目录：数据库固定存放在 userData（WAL 打开中不可搬移）；
  // 这里只切换内容文件根目录，并把现有文件复制过去后才落设置。
  ipcMain.handle('data:get-paths', () => {
    const userData = app.getPath('userData')
    return {
      userData,
      contentDir: fileService.getBaseDir(),
      defaultContentDir: join(userData, 'content'),
      databasePath: join(userData, 'zuixiaoshuo.db'),
    }
  })
  ipcMain.handle('data:set-content-dir', async (_event, targetDir: string) => {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    // migrateTo 内部在写队列独占期完成复制、落设置与切换：
    // 设置写失败会回滚复制并保持旧目录生效。
    const plan = await fileService.migrateTo(String(targetDir ?? ''), (p) => {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('dataPath', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      ).run(p.targetDir)
    })
    return { contentDir: plan.targetDir, copiedFiles: plan.copiedFiles.length }
  })

  // Action logging
  ipcMain.handle('log:action', (_event, category: string, action: string, detail?: string) => {
    actionLogger.log(category, action, detail)
  })
  // 错误 / 告警日志（渲染进程通过 console.error / window.onerror 转发）
  ipcMain.handle('log:error', (_event, category: string, action: string, detail?: string) => {
    actionLogger.error(category, action, detail)
  })
  ipcMain.handle('log:warn', (_event, category: string, action: string, detail?: string) => {
    actionLogger.warn(category, action, detail)
  })
  ipcMain.handle('log:debug', (_event, category: string, action: string, detail?: string) => {
    actionLogger.debug(category, action, detail)
  })

  // 归一化参数：数组直接展开、单值包装为数组、空值用空数组。
  // 参数个数是否正确由 better-sqlite3 原生校验（参数不匹配时会抛出清晰的错误）。
  function normalizeParams(params?: unknown[]): unknown[] {
    if (Array.isArray(params)) return params
    if (params === undefined || params === null) return []
    return [params]
  }

  // Database operations
  ipcMain.handle('db:query', (_event, sql: string, params?: unknown[]) => {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    const stmt = db.prepare(sql)
    const safe = normalizeParams(params)
    if (sql.trim().toLowerCase().startsWith('select')) {
      return stmt.all(...safe)
    }
    return stmt.run(...safe)
  })
  ipcMain.handle('db:transaction', (_event, queries: { sql: string; params?: unknown[] }[]) => {
    const db = getDatabase()
    if (!db) throw new Error('Database not initialized')
    const result: unknown[] = []
    const runQuery = db.transaction(() => {
      for (const q of queries) {
        const stmt = db.prepare(q.sql)
        const safe = normalizeParams(q.params)
        if (q.sql.trim().toLowerCase().startsWith('select')) {
          result.push(stmt.all(...safe))
        } else {
          result.push(stmt.run(...safe))
        }
      }
    })
    runQuery()
    return result
  })

  // API Key 加密 / 解密（safeStorage 或回退方案）
  ipcMain.handle('key:encrypt', (_event, plain: string) => encryptKey(plain))
  ipcMain.handle('key:decrypt', (_event, payload: string) => decryptKey(payload))

  // 应用版本
  ipcMain.handle('app:getVersion', () => app.getVersion())

  // 质量门禁（P2-1）：跑 story-review 确定性 deslop 脚本，
  // 让渲染层 runQualityGate 走真实脚本而非恒启发式降级。失败时渲染层自行降级。
  ipcMain.handle('quality:check', (_event, text: string) => checkQuality(String(text ?? ''), app.getAppPath()))

  // 规划提案契约校验：跑 story-plan-workspace 的 validate-proposal.js
  ipcMain.handle('plan:validate', (_event, input: PlanValidationInput) =>
    validatePlanProposal(input, app.getAppPath()),
  )
  // 大纲结构体检：跑 check-plan-health.js
  ipcMain.handle('plan:health', (_event, input: PlanHealthInput) =>
    checkPlanHealth(input, app.getAppPath()),
  )
}

function createAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '返回主页', click: () => mainWindow?.webContents.send('navigate', '/') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
      ],
    },
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData')
  initDatabase(userDataPath)
  // 用户操作日志: 默认写入 userData/log.txt; 开发模式下额外写入项目根目录 log.txt, 方便直接查看
  const isDev = !!process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development'
  const logPaths = [join(userDataPath, 'log.txt')]
  if (isDev) logPaths.push(join(process.cwd(), 'log.txt'))
  actionLogger.init(logPaths)
  installGlobalErrorHandlers()
  skillVault.load()
  registerIpcHandlers()
  // 启动时根据已保存的 dataPath 设置文件根目录，使 content 相对路径落到用户数据目录
  try {
    const row = getDatabase()?.prepare('SELECT value FROM settings WHERE key = ?').get('dataPath') as
      | { value: string }
      | undefined
    if (row && row.value && isAbsolute(row.value)) {
      fileService.setBaseDir(row.value)
    }
  } catch (e) {
    console.error('Failed to load dataPath for file base dir:', e)
  }
  createAppMenu()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    mainWindow = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
