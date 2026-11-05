import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, GitBranch, CheckCircle2, XCircle, Loader2, Circle } from 'lucide-react'
import { cn } from '@/utils/cn'
import { AGENT_ROLE_LABELS } from '@shared/constants'
import { loadLedger, type RoleLedgerEntry, type LedgerChainNode } from '@/services/tracking-service'
import { Button } from '@/components/ui/button'

const ACTION_LABEL: Record<LedgerChainNode['action'], string> = {
  generate: '生成',
  review: '审核',
  fix: '修复',
  inject: '回灌',
}

const ACTION_COLOR: Record<LedgerChainNode['action'], string> = {
  generate: 'text-sky-400 border-sky-400/30 bg-sky-400/10',
  review: 'text-violet-400 border-violet-400/30 bg-violet-400/10',
  fix: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  inject: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
}

function NodeStatus({ status }: { status: LedgerChainNode['status'] }) {
  if (status === 'done') return <CheckCircle2 size={11} className="text-emerald-400" />
  if (status === 'failed') return <XCircle size={11} className="text-red-400" />
  if (status === 'pending') return <Circle size={11} className="text-muted-foreground/50" />
  return <Loader2 size={11} className="animate-spin text-primary" />
}

function ChainRow({ node }: { node: LedgerChainNode }) {
  const role = AGENT_ROLE_LABELS[node.agentRole]
  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-medium whitespace-nowrap',
          ACTION_COLOR[node.action]
        )}
      >
        <span>{role?.emoji ?? '🤖'}</span>
        <span>{ACTION_LABEL[node.action]}</span>
        <span className="opacity-70">{role?.name ?? node.agentRole}</span>
      </div>
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
        <NodeStatus status={node.status} />
        {node.note && <span className="max-w-[80px] truncate" title={node.note}>{node.note}</span>}
      </div>
    </div>
  )
}

export default function RoleLedgerPanel({
  novelId,
  onReady,
}: {
  novelId: string
  onReady?: (refresh: () => void) => void
}) {
  const [entries, setEntries] = useState<RoleLedgerEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!novelId) return
    setLoading(true)
    try {
      const data = await loadLedger(novelId)
      setEntries(data)
    } catch (e) {
      console.error('[RoleLedgerPanel] loadLedger failed', e)
    } finally {
      setLoading(false)
    }
  }, [novelId])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    onReady?.(refresh)
  }, [onReady, refresh])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <GitBranch size={13} className="text-violet-400" />
          角色资源账本
          <span className="text-[10px] text-muted-foreground font-normal">
            （生成 → 审核 → 修复 → 回灌）
          </span>
        </div>
        <Button size="icon" variant="ghost" onClick={refresh} className="h-6 w-6" disabled={loading}>
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-muted-foreground">
          {loading ? '加载中…' : '暂无账本记录，运行导演后会自动记录章节执行链'}
        </div>
      ) : (
        <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="p-2.5 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm"
            >
              <div className="text-[11px] font-medium text-foreground mb-2 truncate">
                {entry.chapterTitle ?? '章节'}
                <span className="ml-2 text-[9px] text-muted-foreground font-normal">
                  {entry.updatedAt?.slice(0, 19)?.replace('T', ' ')}
                </span>
              </div>
              <div className="flex items-start gap-1.5 overflow-x-auto pb-1">
                {entry.chain.map((node, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <ChainRow node={node} />
                    {i < entry.chain.length - 1 && (
                      <div className="w-3 h-px bg-gradient-to-r from-violet-400/40 to-sky-400/40 shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
