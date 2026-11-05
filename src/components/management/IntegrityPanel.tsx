import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileWarning, FolderOpen, Loader2, RefreshCw, Wrench } from 'lucide-react'
import {
  chapterService,
  markChapterMissing,
  repairChapterWordCount,
  verifyChapterIntegrity,
  type ChapterIntegrityIssue,
} from '@/services/data-service'
import { useWorkbenchStore } from '@/stores'
import { cn } from '@/utils/cn'

export default function IntegrityPanel({ novelId }: { novelId: string }) {
  const selectChapter = useWorkbenchStore((s) => s.selectChapter)
  const [issues, setIssues] = useState<ChapterIntegrityIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [scanned, setScanned] = useState(false)

  const scan = useCallback(async () => {
    setLoading(true)
    setMsg(null)
    try {
      const list = await verifyChapterIntegrity(novelId)
      setIssues(list)
      setScanned(true)
    } catch (e) {
      setMsg({ ok: false, text: `扫描失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setLoading(false)
    }
  }, [novelId])

  useEffect(() => {
    void scan()
  }, [scan])

  const handleOpen = async (issue: ChapterIntegrityIssue) => {
    try {
      const chapter = await chapterService.getById(issue.chapterId)
      if (chapter) selectChapter(chapter)
    } catch (e) {
      setMsg({ ok: false, text: `打开章节失败：${(e as Error)?.message || '未知错误'}` })
    }
  }

  const handleRepair = async (issue: ChapterIntegrityIssue) => {
    setBusyId(issue.chapterId)
    try {
      const result = await repairChapterWordCount(issue.chapterId)
      if (!result.ok) {
        setMsg({ ok: false, text: result.error || '回填失败' })
        return
      }
      setMsg({ ok: true, text: `《${issue.title}》已按正文回填为 ${result.wordCount} 字` })
      await scan()
    } finally {
      setBusyId(null)
    }
  }

  const handleMarkMissing = async (issue: ChapterIntegrityIssue) => {
    if (!window.confirm(`将《${issue.title}》字数清零并退回草稿？正文文件不会被删除。`)) return
    setBusyId(issue.chapterId)
    try {
      await markChapterMissing(issue.chapterId)
      setMsg({ ok: true, text: `《${issue.title}》已标记为正文缺失` })
      await scan()
    } catch (e) {
      setMsg({ ok: false, text: `标记失败：${(e as Error)?.message || '未知错误'}` })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b border-border/20 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          核对数据库字数与正文文件是否一致
        </span>
        <button
          onClick={() => void scan()}
          disabled={loading}
          className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          重新扫描
        </button>
      </div>

      {msg && (
        <div
          className={cn(
            'mx-3 mt-2 px-2.5 py-1.5 rounded text-[11px]',
            msg.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
          )}
        >
          {msg.text}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {loading && issues.length === 0 && (
          <div className="flex items-center justify-center py-12 text-xs text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            正在核对章节完整性…
          </div>
        )}

        {!loading && issues.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground/60 leading-relaxed">
            <CheckCircle2 size={28} className="text-green-400/60 mb-2" />
            {scanned ? '未发现缺失或字数不一致的章节' : '尚未扫描'}
          </div>
        )}

        {issues.map((issue) => {
          const isMissing = issue.kind === 'missing'
          const Icon = isMissing ? FileWarning : AlertTriangle
          const busy = busyId === issue.chapterId
          return (
            <div key={issue.chapterId} className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Icon size={13} className={isMissing ? 'text-red-400' : 'text-amber-400'} />
                <span className="text-[12px] font-medium text-foreground">
                  第{issue.order}章《{issue.title}》
                </span>
                <span
                  className={cn(
                    'text-[9px] px-1.5 py-0.5 rounded',
                    isMissing ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
                  )}
                >
                  {isMissing ? '正文缺失' : '字数不一致'}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground leading-relaxed">
                数据库 {issue.dbWordCount} 字 · 正文文件 {issue.fileChars < 0 ? '不存在' : `${issue.fileChars} 字`} · 状态 {issue.status}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={() => void handleOpen(issue)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <FolderOpen size={10} />
                  打开章节
                </button>
                {!isMissing && (
                  <button
                    onClick={() => void handleRepair(issue)}
                    disabled={busy}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors"
                  >
                    {busy ? <Loader2 size={10} className="animate-spin" /> : <Wrench size={10} />}
                    以正文回填字数
                  </button>
                )}
                {isMissing && (
                  <button
                    onClick={() => void handleMarkMissing(issue)}
                    disabled={busy}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40 transition-colors"
                  >
                    {busy ? <Loader2 size={10} className="animate-spin" /> : <Wrench size={10} />}
                    标记缺失
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
