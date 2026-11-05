import { useState } from 'react'
import { FileText, FolderOpen, ClipboardPaste, Loader2, AlertTriangle } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { importStyleSource } from '@/services/style-analysis-service'
import type { CorpusPreview, StyleSource, StyleSourceKind } from '@shared/style-types'
import { cn } from '@/utils/cn'

const KIND_OPTIONS: { key: StyleSourceKind; label: string; hint: string; icon: typeof FileText }[] = [
  { key: 'single_file', label: '整本文件', hint: 'TXT / MD，按「第 X 章」标记切章', icon: FileText },
  { key: 'chapter_dir', label: '章节目录', hint: '一个文件夹，每个文件视为一章', icon: FolderOpen },
  { key: 'paste', label: '粘贴文本', hint: '最多 5 万字，适合短篇或片段', icon: ClipboardPaste },
]

function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() || '未命名语料'
  return name.replace(/\.(txt|md)$/i, '')
}

export default function ImportCorpusDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (source: StyleSource) => void
}) {
  const [kind, setKind] = useState<StyleSourceKind>('single_file')
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<CorpusPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPath('')
    setText('')
    setName('')
    setPreview(null)
    setError(null)
    setBusy(null)
  }

  const choosePath = async () => {
    const picked = kind === 'chapter_dir'
      ? await window.electronAPI.dialog.selectDirectory()
      : await window.electronAPI.dialog.openFile()
    if (!picked) return
    setPath(picked)
    if (!name.trim()) setName(baseName(picked))
    setPreview(null)
  }

  const doPreview = async () => {
    setError(null)
    setBusy('preview')
    try {
      const result = (await window.electronAPI.corpus.preview({
        kind,
        path: kind === 'paste' ? undefined : path,
        text: kind === 'paste' ? text : undefined,
      })) as CorpusPreview
      setPreview(result)
      if (!name.trim() && kind === 'paste') setName('粘贴语料')
    } catch (e) {
      setError((e as Error)?.message || '预览失败，请检查文件')
    } finally {
      setBusy(null)
    }
  }

  const doImport = async () => {
    setError(null)
    setBusy('import')
    try {
      const source = await importStyleSource({
        kind,
        path: kind === 'paste' ? undefined : path,
        text: kind === 'paste' ? text : undefined,
        name: name.trim() || '未命名语料',
      })
      onImported(source as StyleSource)
      reset()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error)?.message || '导入失败')
    } finally {
      setBusy(null)
    }
  }

  const inputReady = kind === 'paste' ? text.trim().length > 0 : !!path
  const canImport = !!preview && preview.chapters.length > 0 && !busy

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入文风语料</DialogTitle>
          <DialogDescription>
            只学习表达方式，不复制原文情节。语料仅保存在本机。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {KIND_OPTIONS.map(({ key, label, hint, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setKind(key); setPreview(null); setError(null) }}
              className={cn(
                'rounded-lg border px-3 py-3 text-left transition-colors',
                kind === key
                  ? 'border-primary/50 bg-primary/10'
                  : 'border-border/50 bg-muted/10 hover:bg-muted/20',
              )}
            >
              <Icon size={15} className={kind === key ? 'text-primary' : 'text-muted-foreground'} />
              <div className="mt-1.5 text-xs font-medium text-foreground">{label}</div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">{hint}</div>
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <label className="text-[11px] text-muted-foreground">来源名称</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：某作者短篇集" />
        </div>

        {kind === 'paste' ? (
          <Textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null) }}
            placeholder="粘贴小说正文…"
            className="min-h-[140px] max-h-[240px] font-mono text-xs"
          />
        ) : (
          <div className="flex items-center gap-2">
            <Input value={path} readOnly placeholder={kind === 'chapter_dir' ? '选择章节目录' : '选择 TXT / MD 文件'} />
            <Button variant="outline" size="sm" onClick={choosePath}>
              {kind === 'chapter_dir' ? '选择目录' : '选择文件'}
            </Button>
          </div>
        )}

        {preview && (
          <div className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-[11px] space-y-1">
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              <span>识别 {preview.chapters.length} 章</span>
              <span>{preview.totalChars.toLocaleString()} 字</span>
              <span>编码 {preview.encoding}</span>
              <span>切分方式 {preview.splitMode === 'directory' ? '按文件' : preview.splitMode === 'chapter_markers' ? '按章节标记' : '按长度块'}</span>
            </div>
            {preview.duplicateChapters > 0 && (
              <div className="text-amber-400">已跳过 {preview.duplicateChapters} 个重复章节</div>
            )}
            {preview.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1 text-amber-400">
                <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-400">{error}</div>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => { reset(); onOpenChange(false) }}>取消</Button>
          <Button variant="outline" onClick={doPreview} disabled={!inputReady || !!busy}>
            {busy === 'preview' ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
            预览切章
          </Button>
          <Button onClick={doImport} disabled={!canImport}>
            {busy === 'import' ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : null}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
