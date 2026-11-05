// F4 拆书分析对话框：选书 → 跑拆书流水线（进度实时） → 产物落盘提示。
// 复用 deconstruct-service 的 async generator；Electron 原生选文件，浏览器回退 <input type="file">。

import { useState, useRef, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { deconstructBook, type DeconstructProgress, type DeconstructResult } from '@/services/deconstruct-service'
import { ActionLog } from '@/services/log-service'

interface DeconstructDialogProps {
  open: boolean
  onClose: () => void
}

type DialogState = 'select' | 'running' | 'done' | 'error'

const PHASE_LABEL: Record<DeconstructProgress['phase'], string> = {
  parse: '切章',
  analyze: '逐章拆解',
  summarize: '汇总提炼',
  template: '落盘',
  done: '完成',
  error: '出错',
}

export function DeconstructDialog({ open, onClose }: DeconstructDialogProps) {
  const [state, setState] = useState<DialogState>('select')
  const [progress, setProgress] = useState<DeconstructProgress | null>(null)
  const [result, setResult] = useState<DeconstructResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 关闭时中止还在跑的流水线
  useEffect(() => {
    if (!open && state === 'running') abortRef.current?.abort()
  }, [open, state])

  const resetDialog = () => {
    setState('select')
    setProgress(null)
    setResult(null)
    setErrorMsg('')
    abortRef.current?.abort()
    abortRef.current = null
  }

  const handleClose = () => {
    resetDialog()
    onClose()
  }

  const runDeconstruct = async (content: string, filename: string) => {
    setState('running')
    setProgress({ phase: 'parse', message: '准备开始…' })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const gen = deconstructBook(content, filename, { signal: controller.signal })
      let final: DeconstructResult | undefined
      for (;;) {
        const { value, done } = await gen.next()
        if (done) {
          final = value as DeconstructResult | undefined
          break
        }
        if (value.phase === 'error') {
          setErrorMsg(value.message)
          setState('error')
          return
        }
        setProgress(value)
      }
      if (final) {
        setResult(final)
        ActionLog.novel('deconstruct', `拆书完成：${final.sampledChapters}/${final.totalChapters} 章，模板已存为「我的模板」`)
        setState('done')
      } else {
        setErrorMsg('拆书流程提前结束')
        setState('error')
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '拆书过程中发生错误')
      setState('error')
    }
  }

  // Electron 环境：原生对话框选文件后直接开跑
  const handleElectronSelect = async () => {
    try {
      const filePath = await window.electronAPI.dialog.openFile()
      if (!filePath) return
      const content = await window.electronAPI.file.read(filePath)
      const filename = filePath.split(/[/\\]/).pop() || 'untitled.txt'
      await runDeconstruct(content, filename)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取文件失败')
      setState('error')
    }
  }

  // 浏览器回退：<input type="file">
  const handleBrowserSelect = () => fileInputRef.current?.click()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const content = await file.text()
      await runDeconstruct(content, file.name)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取文件失败')
      setState('error')
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-lg bg-[#141416] border border-[#2a2a2e] text-[#e4e4e7]">
        <DialogHeader>
          <DialogTitle className="text-lg text-[#f0f0f5]">
            {state === 'select' && '拆书分析'}
            {state === 'running' && '正在拆书…'}
            {state === 'done' && '拆书完成'}
            {state === 'error' && '拆书出错'}
          </DialogTitle>
          <DialogDescription className="text-[#9d9da5]">
            {state === 'select' && '导入一本完整的小说，AI 提炼主线、角色与开局节奏，存为可套用的模板'}
            {state === 'running' && 'AI 正在逐章拆解，全程无需操作'}
            {state === 'done' && '模板已存入「新建小说 → 从模板开始」，随时可用'}
            {state === 'error' && errorMsg}
          </DialogDescription>
        </DialogHeader>

        {/* 选择阶段 */}
        {state === 'select' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-24 w-24 rounded-2xl bg-[#1c1c20] flex items-center justify-center">
              <svg className="w-10 h-10 text-[#5b5b66]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <p className="text-sm text-[#9d9da5] text-center max-w-xs">
              选择 .txt 或 .md 全本文件。<br />
              章节较多时会自动采样分析（默认最多 30 章），产物可借鉴结构与节奏。
            </p>
            <Button
              onClick={window.electronAPI ? handleElectronSelect : handleBrowserSelect}
              className="bg-[#6366f1] hover:bg-[#5558e6] text-white"
            >
              选择文件
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        )}

        {/* 运行中 */}
        {state === 'running' && progress && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-8 w-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-[#e4e4e7]">{progress.message}</p>
            {progress.chapterTotal != null && progress.phase === 'analyze' && (
              <div className="w-full max-w-xs">
                <div className="h-1.5 rounded-full bg-[#1c1c20] overflow-hidden">
                  <div
                    className="h-full bg-[#6366f1] rounded-full transition-all duration-300"
                    style={{ width: `${Math.round(((progress.chapterIndex ?? 0) / progress.chapterTotal) * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-[#6b6b78] text-center">
                  {progress.chapterIndex} / {progress.chapterTotal} 章
                </p>
              </div>
            )}
            <p className="text-xs text-[#5b5b66]">阶段：{PHASE_LABEL[progress.phase]}</p>
          </div>
        )}

        {/* 完成 */}
        {state === 'done' && result && (
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="h-12 w-12 rounded-full bg-[#22c55e]/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-[#22c55e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-[#e4e4e7]">
              已分析 {result.sampledChapters} / {result.totalChapters} 章
            </p>
            <div className="w-full space-y-1 bg-[#1c1c20] rounded-lg p-3 text-xs text-[#7c7c8a]">
              <div>拆书报告：{result.reportPath}</div>
              <div>逐章拆解：{result.chaptersPath}</div>
              <div className="text-[#a5b4fc]">模板：{result.templatePath}</div>
            </div>
            <p className="text-xs text-[#6b6b78]">新建小说时在「从模板开始」里即可套用</p>
          </div>
        )}

        {/* 错误 */}
        {state === 'error' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="h-12 w-12 rounded-full bg-[#ef4444]/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-[#ef4444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-sm text-[#ef4444] text-center max-w-xs">{errorMsg}</p>
          </div>
        )}

        <DialogFooter>
          {state === 'select' && (
            <Button variant="ghost" onClick={handleClose} className="text-[#9d9da5]">
              取消
            </Button>
          )}
          {state === 'running' && (
            <Button variant="ghost" onClick={handleClose} className="text-[#9d9da5]">
              后台中止并关闭
            </Button>
          )}
          {state === 'done' && (
            <Button onClick={handleClose} className="bg-[#6366f1] hover:bg-[#5558e6] text-white">
              完成
            </Button>
          )}
          {state === 'error' && (
            <>
              <Button variant="ghost" onClick={handleClose} className="text-[#9d9da5]">
                取消
              </Button>
              <Button
                onClick={() => setState('select')}
                className="bg-[#6366f1] hover:bg-[#5558e6] text-white"
              >
                重试
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
