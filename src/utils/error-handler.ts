// Error classification and user-friendly messages

export enum ErrorType {
  Network = 'network',
  Quota = 'quota',
  ContentPolicy = 'content_policy',
  Timeout = 'timeout',
  Auth = 'auth',
  Storage = 'storage',
  Unknown = 'unknown',
}

export interface ClassifiedError {
  type: ErrorType
  title: string
  message: string
  action?: string
  retryable: boolean
}

export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  // Network errors
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return {
      type: ErrorType.Network,
      title: '网络连接失败',
      message: '无法连接到 API 服务器，请检查网络连接后重试。',
      action: '检查网络',
      retryable: true,
    }
  }

  // Quota errors
  if (lower.includes('quota') || lower.includes('rate limit') || lower.includes('429') || lower.includes('insufficient_quota')) {
    return {
      type: ErrorType.Quota,
      title: 'API 配额不足',
      message: '当前 API 使用量已达上限，请升级套餐或等待配额重置。',
      action: '检查配额',
      retryable: false,
    }
  }

  // Content policy errors
  if (lower.includes('content') || lower.includes('policy') || lower.includes('safety') || lower.includes('moderation') || lower.includes('refuse')) {
    return {
      type: ErrorType.ContentPolicy,
      title: '内容策略限制',
      message: '请求内容触发了安全审查，请调整输入内容后重试。',
      retryable: false,
    }
  }

  // Timeout errors
  if (lower.includes('timeout') || lower.includes('abort') || lower.includes('timed out')) {
    return {
      type: ErrorType.Timeout,
      title: '请求超时',
      message: 'API 响应超时，可能因为内容过长或服务器繁忙，请稍后重试。',
      action: '重试',
      retryable: true,
    }
  }

  // Auth errors
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('403') || lower.includes('api key')) {
    return {
      type: ErrorType.Auth,
      title: '认证失败',
      message: 'API Key 无效或已过期，请检查配置中的 API Key 是否正确。',
      action: '检查配置',
      retryable: false,
    }
  }

  // Storage errors
  if (lower.includes('storage') || lower.includes('disk') || lower.includes('write') || lower.includes('file')) {
    return {
      type: ErrorType.Storage,
      title: '存储错误',
      message: '文件读写失败，请检查磁盘空间和文件权限。',
      retryable: true,
    }
  }

  // Unknown
  return {
    type: ErrorType.Unknown,
    title: '未知错误',
    message: message || '发生了一个意外错误，请重试。',
    retryable: true,
  }
}

// Fallback provider chain for automatic degradation
export const FALLBACK_PROVIDERS: Record<string, string[]> = {
  openai: ['deepseek', 'anthropic'],
  anthropic: ['openai', 'deepseek'],
  deepseek: ['openai', 'anthropic'],
}

export function getFallbackProvider(currentProvider: string): string | null {
  const fallbacks = FALLBACK_PROVIDERS[currentProvider]
  if (fallbacks && fallbacks.length > 0) {
    return fallbacks[0]
  }
  return null
}
