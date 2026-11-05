import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { ActionLog } from '@/services/log-service'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // 写入错误日志（含组件栈），供回溯修复
    ActionLog.error('React render error', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    })
    console.error('Uncaught render error:', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: undefined })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-background p-6">
          <div className="max-w-md w-full rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center animate-fade-in">
            <div className="flex justify-center mb-3">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle size={24} className="text-red-400" />
              </div>
            </div>
            <h2 className="text-base font-semibold text-red-300 mb-1">应用遇到了错误</h2>
            <p className="text-sm text-red-400/80 mb-4 break-words">
              {this.state.error?.message || '发生了一个意外错误'}
            </p>
            <button
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-500/20 text-red-200 hover:bg-red-500/30 transition-colors cursor-pointer text-sm"
            >
              <RotateCcw size={14} />
              重新加载
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
