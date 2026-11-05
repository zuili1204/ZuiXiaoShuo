import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  window: {
    minimize: () => Promise<void>
    maximize: () => Promise<void>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
  }
  dialog: {
    openFile: () => Promise<string | null>
    selectDirectory: () => Promise<string | null>
    saveFile: (defaultName?: string) => Promise<string | null>
  }
  data: {
    getPaths: () => Promise<{ userData: string; contentDir: string; defaultContentDir: string; databasePath: string }>
    setContentDir: (dir: string) => Promise<{ contentDir: string; copiedFiles: number }>
  }
  file: {
    read: (path: string) => Promise<string>
    write: (path: string, content: string) => Promise<void>
    writeBase64: (path: string, base64: string) => Promise<void>
    delete: (path: string) => Promise<void>
    deleteDir: (dirPath: string) => Promise<void>
    rename: (fromPath: string, toPath: string) => Promise<void>
    list: (dirPath: string) => Promise<string[]>
    exists: (path: string) => Promise<boolean>
    mkdir: (dirPath: string) => Promise<void>
  }
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown>
    transaction: (queries: { sql: string; params?: unknown[] }[]) => Promise<unknown[]>
  }
  key: {
    encrypt: (plain: string) => Promise<string>
    decrypt: (payload: string) => Promise<string>
  }
  skills: {
    readFile: (relKey: string) => string | null
  }
  quality: {
    check: (text: string) => Promise<unknown>
  }
  plan: {
    validate: (input: { stage: string; proposal: unknown; writtenIds?: string[] }) => Promise<unknown>
    health: (input: { plan: unknown; writtenIds?: string[] }) => Promise<unknown>
  }
  app: {
    getVersion: () => Promise<string>
  }
  corpus: {
    preview: (input: { path?: string; kind: string; text?: string }) => Promise<unknown>
    import: (input: { sourceId: string; name: string; path?: string; kind: string; text?: string }) => Promise<unknown>
    delete: (sourceId: string) => Promise<void>
  }
  style: {
    metrics: (text: string) => Promise<unknown>
    similarity: (input: { text: string; sourceIds?: string[]; entities?: string[] }) => Promise<unknown>
  }
  logAction: (category: string, action: string, detail?: string) => Promise<void>
  logError: (category: string, action: string, detail?: string) => Promise<void>
  logWarn: (category: string, action: string, detail?: string) => Promise<void>
  logDebug: (category: string, action: string, detail?: string) => Promise<void>
}

const api: ElectronAPI = {
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },
  dialog: {
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    saveFile: (defaultName?: string) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  },
  data: {
    getPaths: () => ipcRenderer.invoke('data:get-paths'),
    setContentDir: (dir: string) => ipcRenderer.invoke('data:set-content-dir', dir),
  },
  file: {
    read: (path: string) => ipcRenderer.invoke('file:read', path),
    write: (path: string, content: string) => ipcRenderer.invoke('file:write', path, content),
    writeBase64: (path: string, base64: string) => ipcRenderer.invoke('file:write-base64', path, base64),
    delete: (path: string) => ipcRenderer.invoke('file:delete', path),
    deleteDir: (dirPath: string) => ipcRenderer.invoke('file:delete-dir', dirPath),
    rename: (fromPath: string, toPath: string) => ipcRenderer.invoke('file:rename', fromPath, toPath),
    list: (dirPath: string) => ipcRenderer.invoke('file:list', dirPath),
    exists: (path: string) => ipcRenderer.invoke('file:exists', path),
    mkdir: (dirPath: string) => ipcRenderer.invoke('file:mkdir', dirPath),
  },
  db: {
    query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('db:query', sql, params),
    transaction: (queries) => ipcRenderer.invoke('db:transaction', queries),
  },
  key: {
    encrypt: (plain: string) => ipcRenderer.invoke('key:encrypt', plain),
    decrypt: (payload: string) => ipcRenderer.invoke('key:decrypt', payload),
  },
  skills: {
    readFile: (relKey) => ipcRenderer.sendSync('skill:read-file', relKey) as string | null,
  },
  quality: {
    check: (text: string) => ipcRenderer.invoke('quality:check', text),
  },
  plan: {
    validate: (input) => ipcRenderer.invoke('plan:validate', input),
    health: (input) => ipcRenderer.invoke('plan:health', input),
  },
  corpus: {
    preview: (input: { path?: string; kind: string; text?: string }) =>
      ipcRenderer.invoke('corpus:preview', input),
    import: (input: { sourceId: string; name: string; path?: string; kind: string; text?: string }) =>
      ipcRenderer.invoke('corpus:import', input),
    delete: (sourceId: string) => ipcRenderer.invoke('corpus:delete', sourceId),
  },
  style: {
    metrics: (text: string) => ipcRenderer.invoke('style:metrics', text),
    similarity: (input: { text: string; sourceIds?: string[]; entities?: string[] }) =>
      ipcRenderer.invoke('style:similarity', input),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  logAction: (category, action, detail) => ipcRenderer.invoke('log:action', category, action, detail),
  logError: (category, action, detail) => ipcRenderer.invoke('log:error', category, action, detail),
  logWarn: (category, action, detail) => ipcRenderer.invoke('log:warn', category, action, detail),
  logDebug: (category, action, detail) => ipcRenderer.invoke('log:debug', category, action, detail),
}

contextBridge.exposeInMainWorld('electronAPI', api)
