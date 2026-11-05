import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { parseTextFile, type ImportResult } from '@/services/import-service'
import { novelService, volumeService, chapterService, characterService } from '@/services/data-service'
import type { Novel, Volume, Chapter, Character } from '@shared/types'

interface ImportNovelDialogProps {
  open: boolean
  onClose: () => void
  onSuccess: (novelId: string) => void
}

type DialogState = 'select' | 'preview' | 'importing' | 'done' | 'error'

export function ImportNovelDialog({ open, onClose, onSuccess }: ImportNovelDialogProps) {
  const [state, setState] = useState<DialogState>('select')
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetDialog = () => {
    setState('select')
    setImportResult(null)
    setErrorMsg('')
  }

  const handleClose = () => {
    resetDialog()
    onClose()
  }

  // Electron 环境：使用原生对话框选择文件
  const handleElectronSelect = async () => {
    try {
      const filePath = await window.electronAPI.dialog.openFile()
      if (!filePath) {
        return
      }
      const content = await window.electronAPI.file.read(filePath)
      const filename = filePath.split(/[/\\]/).pop() || 'untitled.txt'
      const result = parseTextFile(content, filename)
      setImportResult(result)
      setState('preview')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取文件失败')
      setState('error')
    }
  }

  // 浏览器回退：使用 <input type="file">
  const handleBrowserSelect = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const content = await file.text()
      const result = parseTextFile(content, file.name)
      setImportResult(result)
      setState('preview')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '读取文件失败')
      setState('error')
    }
  }

  const handleImport = async () => {
    if (!importResult) return
    setState('importing')

    try {
      const novelId = crypto.randomUUID()
      const now = new Date().toISOString()

      // 1. 创建小说
      const novel: Novel = {
        id: novelId,
        title: importResult.title,
        description: importResult.description,
        coverPath: null,
        genre: [],
        targetPlatform: 'web',
        status: 'draft',
        wordCount: importResult.totalWordCount,
        chapterCount: importResult.volumes.reduce((sum, v) => sum + v.chapters.length, 0),
        createdAt: now,
        updatedAt: now,
      }
      await novelService.create(novel)

      // 2. 创建卷和章节
      let globalOrder = 1
      for (const vol of importResult.volumes) {
        const volumeId = crypto.randomUUID()
        const volume: Volume = {
          id: volumeId,
          novelId,
          title: vol.title,
          order: importResult.volumes.indexOf(vol) + 1,
          summary: '',
          createdAt: now,
          updatedAt: now,
        }
        await volumeService.create(volume)

        for (const ch of vol.chapters) {
          const chapterId = crypto.randomUUID()
          const contentPath = `content/${novelId}/${chapterId}.md`
          const chapter: Chapter = {
            id: chapterId,
            volumeId,
            title: ch.title,
            order: globalOrder,
            contentPath,
            wordCount: ch.wordCount,
            targetWordCount: 3000,
            status: 'draft',
            hooks: [],
            summary: '',
            createdAt: now,
            updatedAt: now,
          }
          await chapterService.create(chapter)
          // 写入章节实际内容
          await chapterService.saveContent(chapterId, ch.content)
          globalOrder++
        }
      }

      // 3. 创建角色
      for (const char of importResult.characters) {
        const character: Character = {
          id: crypto.randomUUID(),
          novelId,
          name: char.name,
          role: (['protagonist', 'antagonist', 'supporting', 'functional'].includes(char.role)
            ? char.role
            : 'supporting') as Character['role'],
          profile: `出场 ${char.appearances} 次，由导入自动识别`,
          dynamicState: '',
          createdAt: now,
          updatedAt: now,
        }
        await characterService.create(character)
      }

      setState('done')
      onSuccess(novelId)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '导入过程中发生错误')
      setState('error')
    }
  }

  const totalChapters = importResult
    ? importResult.volumes.reduce((sum, v) => sum + v.chapters.length, 0)
    : 0

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-lg bg-[#141416] border border-[#2a2a2e] text-[#e4e4e7]">
        <DialogHeader>
          <DialogTitle className="text-lg text-[#f0f0f5]">
            {state === 'select' && '导入小说'}
            {state === 'preview' && '预览导入内容'}
            {state === 'importing' && '正在导入...'}
            {state === 'done' && '导入完成'}
            {state === 'error' && '导入出错'}
          </DialogTitle>
          <DialogDescription className="text-[#9d9da5]">
            {state === 'select' && '选择 .txt 或 .md 文件，自动识别章节和角色'}
            {state === 'preview' && '请确认以下解析结果，确认后开始导入'}
            {state === 'importing' && '正在将数据写入数据库...'}
            {state === 'done' && '小说已成功导入！'}
            {state === 'error' && errorMsg}
          </DialogDescription>
        </DialogHeader>

        {/* 文件选择阶段 */}
        {state === 'select' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="h-24 w-24 rounded-2xl bg-[#1c1c20] flex items-center justify-center">
              <svg className="w-10 h-10 text-[#5b5b66]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9m1.5-6H9m4.5 3H9m7.5 3.75H3.75m0 0A2.25 2.25 0 001.5 13.5v-9a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0119.5 4.5v9a2.25 2.25 0 01-2.25 2.25z" />
              </svg>
            </div>
            <p className="text-sm text-[#9d9da5]">支持 .txt 和 .md 格式</p>
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

        {/* 预览阶段 */}
        {state === 'preview' && importResult && (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              <PreviewItem label="书名" value={importResult.title} />
              <PreviewItem label="总字数" value={importResult.totalWordCount.toLocaleString()} />
              <PreviewItem label="卷数" value={`${importResult.volumes.length}`} />
              <PreviewItem label="章节数" value={`${totalChapters}`} />
              <PreviewItem label="识别角色" value={`${importResult.characters.length} 人`} />
              <PreviewItem label="简介"
                value={importResult.description.slice(0, 40) + (importResult.description.length > 40 ? '...' : '')}
              />
            </div>

            {/* 卷章预览 */}
            <div className="max-h-40 overflow-y-auto space-y-1 bg-[#1c1c20] rounded-lg p-3">
              {importResult.volumes.slice(0, 3).map((vol) => (
                <div key={vol.title} className="text-sm">
                  <span className="text-[#a5b4fc] font-medium">{vol.title}</span>
                  <span className="text-[#6b6b78]"> · {vol.chapters.length}章</span>
                  {vol.chapters.length <= 5 ? (
                    <div className="ml-4 mt-0.5 space-y-0.5">
                      {vol.chapters.map((ch) => (
                        <div key={ch.order} className="text-xs text-[#7c7c8a]">
                          {ch.title} ({ch.wordCount.toLocaleString()}字)
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="ml-4 mt-0.5 text-xs text-[#7c7c8a]">
                      {vol.chapters.slice(0, 3).map((ch) => (
                        <div key={ch.order}>{ch.title} ({ch.wordCount.toLocaleString()}字)</div>
                      ))}
                      <div>... 还有 {vol.chapters.length - 3} 章</div>
                    </div>
                  )}
                </div>
              ))}
              {importResult.volumes.length > 3 && (
                <div className="text-xs text-[#6b6b78]">... 还有 {importResult.volumes.length - 3} 卷</div>
              )}
            </div>

            {/* 角色预览 */}
            {importResult.characters.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {importResult.characters.slice(0, 10).map((ch) => (
                  <Badge key={ch.name} variant="secondary" className="bg-[#1c1c20] text-[#c4c4cc] text-xs">
                    {ch.name} ({ch.appearances})
                  </Badge>
                ))}
                {importResult.characters.length > 10 && (
                  <Badge variant="outline" className="text-xs text-[#6b6b78]">
                    +{importResult.characters.length - 10}
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        {/* 导入中 */}
        {state === 'importing' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="h-8 w-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-[#9d9da5]">正在创建小说结构...</p>
          </div>
        )}

        {/* 完成 */}
        {state === 'done' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="h-12 w-12 rounded-full bg-[#22c55e]/20 flex items-center justify-center">
              <svg className="w-6 h-6 text-[#22c55e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-[#9d9da5]">
              《{importResult?.title}》已导入成功
            </p>
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
          {state === 'preview' && (
            <>
              <Button variant="ghost" onClick={handleClose} className="text-[#9d9da5]">
                取消
              </Button>
              <Button onClick={handleImport} className="bg-[#6366f1] hover:bg-[#5558e6] text-white">
                确认导入
              </Button>
            </>
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
              <Button onClick={() => setState('select')} className="bg-[#6366f1] hover:bg-[#5558e6] text-white">
                重试
              </Button>
            </>
          )}
          {(state === 'select' || state === 'importing') && (
            <Button variant="ghost" onClick={handleClose} className="text-[#9d9da5]">
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 预览字段行
function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#1c1c20] rounded-lg px-3 py-2">
      <div className="text-xs text-[#6b6b78]">{label}</div>
      <div className="text-sm text-[#e4e4e7] truncate">{value}</div>
    </div>
  )
}
