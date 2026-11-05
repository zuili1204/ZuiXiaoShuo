import { useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import HomePage from '@/pages/HomePage'
import WorkbenchPage from '@/pages/WorkbenchPage'
import PlanPage from '@/pages/PlanPage'
import SettingsPage from '@/pages/SettingsPage'
import StyleLibraryPage from '@/pages/StyleLibraryPage'
import HelpPage from '@/pages/HelpPage'
import { useGlobalActionLog } from '@/hooks/useActionLog'
import { useSettingsStore } from '@/stores/settings-store'
import { recoverAllPendingSessions, flushAllSessions } from '@/services/session-service'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'

// 路由与全局日志监听必须放在 <Router> 内部，否则 useLocation() 会抛错
function AppRoutes() {
  useGlobalActionLog()
  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workbench/:novelId" element={<WorkbenchPage />} />
        <Route path="/plan/:novelId" element={<PlanPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/styles" element={<StyleLibraryPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

function App() {
  const hydrate = useSettingsStore((s) => s.hydrate)
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // 日更会话：启动补记异常退出遗留的会话；退出前尽量落盘（失败则保留草稿）
  useEffect(() => {
    recoverAllPendingSessions().catch((e) => console.warn('[session] recover failed:', e))
    const onBeforeUnload = () => {
      void flushAllSessions()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <ErrorBoundary>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </ErrorBoundary>
  )
}

export default App
