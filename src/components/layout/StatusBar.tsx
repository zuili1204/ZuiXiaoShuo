import { useEffect, useState } from 'react'
import { checkForUpdate, type UpdateInfo } from '@/services/update-checker'
import { getSetting } from '@/services/settings-service'
import { cn } from '@/utils/cn'

interface StatusBarProps {
  wordCount?: number
  totalWordCount?: number
  chapterInfo?: string
  extra?: string
}

export default function StatusBar({ wordCount = 0, totalWordCount = 0, chapterInfo = '', extra }: StatusBarProps) {
  // P2-9：状态栏显示当前版本；settings 配置了 update.manifestUrl 时一并做更新检查，
  // 发现新版本亮提示（未配置清单时离线安全，仅显示版本号）。
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const manifestUrl = await getSetting<string>('update.manifestUrl', '')
        const info = await checkForUpdate(manifestUrl || undefined)
        if (!cancelled) setUpdateInfo(info)
      } catch {
        // 离线/无 API 环境静默降级：不显示版本也不影响状态栏
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="h-7 flex items-center justify-between px-3 text-xs text-muted-foreground bg-sidebar border-t border-border/40 select-none">
      <div className="flex items-center gap-4">
        <span>字数: {wordCount.toLocaleString()}</span>
        <span className="text-border/60">|</span>
        <span>共 {totalWordCount.toLocaleString()} 字</span>
        {updateInfo?.currentVersion && (
          <>
            <span className="text-border/60">|</span>
            <span className="font-mono text-[10px]">v{updateInfo.currentVersion}</span>
          </>
        )}
        {updateInfo?.hasUpdate && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400"
            title={updateInfo.releaseNotes || `最新版本 v${updateInfo.latestVersion}，请前往设置页查看`}
          >
            发现新版本 v{updateInfo.latestVersion}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        {chapterInfo && (
          <>
            <span>{chapterInfo}</span>
            <span className="text-border/60">|</span>
          </>
        )}
        {extra && <span>{extra}</span>}
        <span className={cn(
          'w-2 h-2 rounded-full',
          wordCount > 0 ? 'bg-success' : 'bg-muted-foreground/30'
        )} />
      </div>
    </div>
  )
}
