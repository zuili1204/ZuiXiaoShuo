import { describe, it, expect } from 'vitest'
import { classifyError, ErrorType } from '../error-handler'

describe('Error Handler', () => {
  it('should classify network errors', () => {
    const result = classifyError(new Error('fetch failed'))
    expect(result.type).toBe(ErrorType.Network)
    expect(result.retryable).toBe(true)
  })

  it('should classify quota errors', () => {
    const result = classifyError(new Error('insufficient_quota'))
    expect(result.type).toBe(ErrorType.Quota)
    expect(result.retryable).toBe(false)
  })

  it('should classify auth errors', () => {
    const result = classifyError(new Error('401 Unauthorized'))
    expect(result.type).toBe(ErrorType.Auth)
    expect(result.retryable).toBe(false)
  })

  it('should handle unknown errors', () => {
    const result = classifyError(new Error('some random error'))
    expect(result.type).toBe(ErrorType.Unknown)
    expect(result.retryable).toBe(true)
  })
})
