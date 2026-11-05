// 主进程 API Key 加密服务
// 优先使用 Electron safeStorage (OS 级 DPAPI/Keychain)，不可用时回退到 Node crypto AES

import { safeStorage, app } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const FALLBACK_KEY_FILE = 'key-fallback.key'

let safeStorageAvailable: boolean | null = null
let fallbackSecret: Buffer | null = null

function isSafeStorageAvailable(): boolean {
  if (safeStorageAvailable !== null) return safeStorageAvailable
  try {
    safeStorageAvailable = safeStorage.isEncryptionAvailable()
  } catch {
    safeStorageAvailable = false
  }
  return safeStorageAvailable
}

// 回退方案：用随机密钥文件 + AES-256-CBC 加密（密钥存于用户目录）
function getFallbackSecret(): Buffer {
  if (fallbackSecret) return fallbackSecret
  const keyPath = join(app.getPath('userData'), FALLBACK_KEY_FILE)
  if (existsSync(keyPath)) {
    fallbackSecret = readFileSync(keyPath)
  } else {
    fallbackSecret = randomBytes(32)
    writeFileSync(keyPath, fallbackSecret)
  }
  return fallbackSecret
}

export function encryptKey(plain: string): string {
  if (!plain) return ''
  if (isSafeStorageAvailable()) {
    try {
      return `ss1:${safeStorage.encryptString(plain).toString('base64')}`
    } catch (e) {
      console.error('safeStorage encrypt failed, fallback:', e)
    }
  }
  const secret = getFallbackSecret()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', secret, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `fb1:${Buffer.concat([iv, enc]).toString('base64')}`
}

export function decryptKey(payload: string): string {
  if (!payload) return ''
  if (payload.startsWith('ss1:')) {
    try {
      const buf = Buffer.from(payload.slice(4), 'base64')
      return safeStorage.decryptString(buf)
    } catch (e) {
      console.error('safeStorage decrypt failed:', e)
      return ''
    }
  }
  if (payload.startsWith('fb1:')) {
    try {
      const secret = getFallbackSecret()
      const raw = Buffer.from(payload.slice(4), 'base64')
      const iv = raw.subarray(0, 16)
      const enc = raw.subarray(16)
      const decipher = createDecipheriv('aes-256-cbc', secret, iv)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
    } catch (e) {
      console.error('fallback decrypt failed:', e)
      return ''
    }
  }
  // 无法识别的格式（旧明文或非法）
  return ''
}
