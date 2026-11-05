import { motion, AnimatePresence } from 'framer-motion'
import { ShieldCheck, ShieldAlert, Loader2, Sparkles, X } from 'lucide-react'
import { useWorkbenchStore } from '@/stores'
import { cn } from '@/utils/cn'

// P0：质量门禁状态卡 - 右下角浮动，展示当前章节评分/去AI味标记/通过拦截
export default function QualityGateCard() {
  const qualityGate = useWorkbenchStore((s) => s.qualityGate)
  const qualityChecking = useWorkbenchStore((s) => s.qualityChecking)
  const setQualityGate = useWorkbenchStore((s) => s.setQualityGate)

  return (
    // 外层容器 pointer-events-none：空容器/退出动画期间不遮挡编辑器点击；
    // 只有实际可见的卡片（pointer-events-auto）才响应交互。
    <div className="absolute bottom-3 right-3 z-20 w-60 pointer-events-none">
      <AnimatePresence mode="wait">
        {qualityChecking && (
          <motion.div
            key="checking"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="rounded-xl border border-cyan-400/30 bg-white/5 p-3 backdrop-blur-md shadow-xl shadow-black/30 pointer-events-auto"
          >
            <div className="flex items-center gap-2 text-cyan-300">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-[12px] font-medium">质量门禁检测中…</span>
            </div>
          </motion.div>
        )}

        {!qualityChecking && qualityGate && (
          <motion.div
            key={qualityGate.checkedAt}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={
              qualityGate.passed
                ? { opacity: 1, y: 0, scale: 1 }
                : { opacity: 1, y: 0, scale: 1, x: [0, -4, 4, -3, 3, 0] }
            }
            transition={
              qualityGate.passed
                ? { type: 'spring', stiffness: 300, damping: 22 }
                : { duration: 0.4 }
            }
            className={cn(
              'rounded-xl border p-3 backdrop-blur-md shadow-xl shadow-black/30 pointer-events-auto',
              qualityGate.passed
                ? 'border-emerald-400/40 bg-emerald-500/10'
                : 'border-red-400/50 bg-red-500/10'
            )}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {qualityGate.passed ? (
                  <ShieldCheck size={15} className="text-emerald-300" />
                ) : (
                  <ShieldAlert size={15} className="text-red-300" />
                )}
                <span className="text-[12px] font-semibold text-foreground">质量门禁</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-[13px] font-bold',
                    qualityGate.passed ? 'text-emerald-300' : 'text-red-300'
                  )}
                >
                  {qualityGate.score}
                </span>
                <button
                  onClick={() => setQualityGate(null)}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
                  title="关闭"
                >
                  <X size={12} />
                </button>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded-full bg-white/10 overflow-hidden">
                <motion.div
                  className={cn('h-full', qualityGate.passed ? 'bg-emerald-400' : 'bg-red-400')}
                  initial={{ width: 0 }}
                  animate={{ width: `${qualityGate.score}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]',
                  qualityGate.deslopTag ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'
                )}
              >
                <Sparkles size={10} />
                {qualityGate.deslopTag ? '已去AI味' : 'AI味风险'}
              </span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                AI句式 {qualityGate.aiPatternHits}
              </span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">
                退化 {qualityGate.degenerationHits}
              </span>
            </div>

            <p
              className={cn(
                'mt-2 text-[10px] font-medium',
                qualityGate.passed ? 'text-emerald-300/80' : 'text-red-300/90'
              )}
            >
              {qualityGate.passed ? '✓ 质量门禁通过' : '⚠ 未通过，已拦截下发，建议去AI味'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
