import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { useUpdateNovel } from '@/hooks/useNovels'
import { cn } from '@/utils/cn'
import type { Novel } from '@shared/types'

interface EditNovelDialogProps {
  novel: Novel
  onClose: () => void
  onSaved?: () => void
}

const GENRE_OPTIONS = ['玄幻', '都市', '仙侠', '科幻', '历史', '悬疑', '言情', '军事', '游戏', '其他']
// Novel.status 是英文枚举（shared/types.ts:8），UI 需展示中文标签，故做值/标签映射
const STATUS_OPTIONS: { value: Novel['status']; label: string }[] = [
  { value: 'planning', label: '筹备中' },
  { value: 'writing', label: '连载中' },
  { value: 'completed', label: '已完结' },
  { value: 'draft', label: '草稿' },
]

export default function EditNovelDialog({ novel, onClose, onSaved }: EditNovelDialogProps) {
  const updateNovel = useUpdateNovel()
  const [title, setTitle] = useState(novel.title)
  const [description, setDescription] = useState(novel.description || '')
  const [genre, setGenre] = useState((Array.isArray(novel.genre) ? novel.genre[0] : novel.genre) || '其他')
  const [status, setStatus] = useState<Novel['status']>(novel.status || 'writing')
  // Novel 无 coverEmoji 字段；封面图统一落在已有的 coverPath 上（该字段此前未被任何 UI 使用）
  const [coverEmoji, setCoverEmoji] = useState(novel.coverPath || '📖')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      await updateNovel.mutateAsync({
        id: novel.id,
        data: {
          title: title.trim(),
          description: description.trim(),
          genre: [genre],
          status,
          coverPath: coverEmoji,
        },
      })
      onSaved?.()
      onClose()
    } catch (e) {
      console.error('Failed to update novel:', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border/50 bg-background p-5 shadow-2xl animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">编辑小说</h2>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-xl bg-primary/15 flex items-center justify-center text-3xl flex-shrink-0">
              {coverEmoji}
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">封面图标</label>
              <input
                value={coverEmoji}
                onChange={(e) => setCoverEmoji(e.target.value.slice(0, 2))}
                className="w-full h-8 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 px-2"
                placeholder="📖"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">书名</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-9 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 px-3"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">简介</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 p-2.5 resize-none"
              placeholder="一句话介绍这本书的世界观与主线…"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">题材</label>
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="w-full h-9 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 px-2"
              >
                {GENRE_OPTIONS.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">状态</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Novel['status'])}
                className="w-full h-9 rounded-lg bg-muted/30 border border-border/60 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 px-2"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted/30 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              saving ? 'bg-primary/30 text-primary/70 cursor-wait' : 'bg-primary text-white hover:bg-primary/90 cursor-pointer'
            )}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
