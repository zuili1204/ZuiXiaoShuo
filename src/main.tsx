import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { installGlobalErrorCapture } from '@/services/log-service'
import './index.css'

// 尽早安装全局错误捕获（收集未捕获异常、Promise 拒绝、console.error/warn），
// 保证渲染进程的任何 bug 都能进入 log.txt。
installGlobalErrorCapture()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
