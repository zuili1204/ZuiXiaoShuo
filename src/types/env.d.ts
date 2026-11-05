/// <reference types="vite/client" />

// Type declarations for Electron IPC API
interface ElectronAPI {
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
  plan: {
    validate: (input: { stage: string; proposal: unknown; writtenIds?: string[] }) => Promise<unknown>
    health: (input: { plan: unknown; writtenIds?: string[] }) => Promise<unknown>
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
  app: {
    getVersion: () => Promise<string>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
