import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Minus, Square, X, Settings, CircleHelp } from 'lucide-react'
import { cn } from '@/utils/cn'

export default function TitleBar() {
  const navigate = useNavigate()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    // Detect window state changes
    const handleResize = () => {
      window.electronAPI?.window?.isMaximized().then(setIsMaximized)
    }
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleMinimize = () => window.electronAPI?.window?.minimize()
  const handleMaximize = () => window.electronAPI?.window?.maximize()
  const handleClose = () => window.electronAPI?.window?.close()

  return (
    <div className="fixed top-0 left-0 right-0 h-9 drag-region flex items-center justify-between bg-sidebar border-b border-border/40 z-50 select-none">
      {/* App title - left */}
      <div className="flex items-center gap-2 pl-3">
        <svg className="w-4 h-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
        <span className="text-xs text-muted-foreground font-medium">醉小说</span>
      </div>

      {/* Center - Navigation */}
      <div className="absolute left-1/2 -translate-x-1/2 no-drag flex items-center gap-1">
        <button
          onClick={() => navigate('/settings')}
          className={cn(
            'px-2 py-1 flex items-center gap-1',
            'text-[10px] text-muted-foreground hover:text-foreground',
            'rounded hover:bg-muted/30 transition-colors'
          )}
        >
          <Settings size={12} />
          设置
        </button>
        <button
          onClick={() => navigate('/help')}
          className={cn(
            'px-2 py-1 flex items-center gap-1',
            'text-[10px] text-muted-foreground hover:text-foreground',
            'rounded hover:bg-muted/30 transition-colors'
          )}
        >
          <CircleHelp size={12} />
          帮助
        </button>
      </div>

      {/* Window controls - right */}
      <div className="flex no-drag h-full">
        <button
          onClick={handleMinimize}
          className={cn(
            'w-11 h-full flex items-center justify-center',
            'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            'transition-colors duration-150'
          )}
          aria-label="最小化"
        >
          <Minus size={15} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleMaximize}
          className={cn(
            'w-11 h-full flex items-center justify-center',
            'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            'transition-colors duration-150'
          )}
          aria-label="最大化"
        >
          <Square size={13} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleClose}
          className={cn(
            'w-11 h-full flex items-center justify-center',
            'text-muted-foreground hover:text-white hover:bg-red-500',
            'transition-colors duration-150'
          )}
          aria-label="关闭"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
