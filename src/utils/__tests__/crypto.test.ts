import { describe, it, expect } from 'vitest'
import { encryptApiKey, decryptApiKey } from '../crypto'

describe('API Key Encryption', () => {
  it('should encrypt and decrypt correctly', () => {
    const original = 'sk-test-api-key-12345'
    const encrypted = encryptApiKey(original)
    expect(encrypted).not.toBe(original)
    expect(encrypted).toBeTruthy()

    const decrypted = decryptApiKey(encrypted)
    expect(decrypted).toBe(original)
  })

  it('should handle empty string', () => {
    expect(encryptApiKey('')).toBe('')
    expect(decryptApiKey('')).toBe('')
  })

  it('should produce different output for different inputs', () => {
    const a = encryptApiKey('key-a')
    const b = encryptApiKey('key-b')
    expect(a).not.toBe(b)
  })
})
