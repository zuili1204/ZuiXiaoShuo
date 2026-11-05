import { AlertTriangle, RotateCcw, ArrowRight } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { ClassifiedError } from '@/utils/error-handler'

interface ErrorCardProps {
  error: ClassifiedError
  onRetry?: () => void
  onFallback?: (providerName: string) => void
  fallbackProviderName?: string
  className?: string
}

export function ErrorCard({
  error,
  onRetry,
  onFallback,
  fallbackProviderName,
  className,
}: ErrorCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm',
        'animate-fade-in',
        className
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="text-red-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-red-300">{error.title}</div>
          <div className="text-[12px] text-red-400/90 mt-0.5 leading-relaxed">
            {error.message}
          </div>
          {(onRetry || onFallback) && (
            <div className="flex items-center gap-2 mt-2">
              {error.retryable && onRetry && (
                <button
                  onClick={onRetry}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px]',
                    'bg-red-500/20 text-red-200 hover:bg-red-500/30',
                    'transition-colors cursor-pointer'
                  )}
                >
                  <RotateCcw size={11} />
                  重试
                </button>
              )}
              {onFallback && fallbackProviderName && (
                <button
                  onClick={() => onFallback(fallbackProviderName)}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px]',
                    'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30',
                    'transition-colors cursor-pointer'
                  )}
                >
                  降级到 {fallbackProviderName}
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// 简单的行内错误提示（无按钮），用于流水线等紧凑场景
export function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-1.5 p-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400">
      <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
}
