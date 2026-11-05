// API Key encryption utility
// Uses a simple XOR + Base64 approach for local key storage
// In production, consider using Electron's safeStorage API

const KEY_SEED = 'ZuiXiaoShuo_2026_v1'

function deriveKey(): string {
  let hash = 0
  for (let i = 0; i < KEY_SEED.length; i++) {
    const char = KEY_SEED.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16).repeat(4).slice(0, 32)
}

export function encryptApiKey(plainKey: string): string {
  if (!plainKey) return ''
  const key = deriveKey()
  let result = ''
  for (let i = 0; i < plainKey.length; i++) {
    const charCode = plainKey.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    result += String.fromCharCode(charCode)
  }
  return btoa(result)
}

export function decryptApiKey(encryptedKey: string): string {
  if (!encryptedKey) return ''
  const key = deriveKey()
  let decoded: string
  decoded = atob(encryptedKey)
  let result = ''
  for (let i = 0; i < decoded.length; i++) {
    const charCode = decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    result += String.fromCharCode(charCode)
  }
  return result
}
