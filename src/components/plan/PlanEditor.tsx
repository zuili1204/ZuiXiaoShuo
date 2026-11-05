import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  FileText,
  Layers,
  Loader2,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Users,
  Wand2,
} from 'lucide-react'
import type { Chapter, Character, Novel, Volume } from '@shared/types'
import type { VolChap } from '@/services/ai-outline'
import { cn } from '@/utils/cn'
import { Button } from '@/components/ui/button'
import SeedCluesCard from './SeedCluesCard'
import {
  chapterDot,
  findChapter,
  flatChapters,
  STATUS_OPTIONS,
  type PlanMode,
  type PlanSelection,
  type SeedForm,
} from './plan-utils'

interface Props {
  novel: Novel
  vols: VolChap[]
  characters: Character[]
  seedForm: SeedForm
  onSeedFormChange: (patch: Partial<SeedForm>) => void
  selection: PlanSelection
  onNovelChange: (patch: Partial<Novel>) => void
  onVolumeChange: (volumeId: string, patch: Partial<Volume>) => void
  onChapterChange: (chapterId: string, patch: Partial<Chapter>) => void
  onAddVolume: () => void
  onAddChapter: (volumeId: string) => void
  onSelect: (selection: PlanSelection) => void
  onOpenAi: (mode: PlanMode) => void
  onHome: () => void
}

const inputCls =
  'h-8 w-full rounded-md bg-muted/25 border border-border/50 px-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20'
const textareaCls =
  'w-full rounded-md bg-muted/25 border border-border/50 px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none leading-relaxed'
const labelCls = 'mb-1 block text-[11px] text-muted-foreground'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>
        {label}
        {hint && <span className="ml-1.5 text-muted-foreground/60">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

function HooksEditor({
  chapter,
  disabled,
  onChange,
}: {
  chapter: Chapter
  disabled: boolean
  onChange: (hooks: string[]) => void
}) {
  const joined = chapter.hooks?.join('\n') ?? ''
  const [text, setText] = useState(joined)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(joined)
  }, [chapter.id, joined])

  return (
    <textarea
      value={text}
      disabled={disabled}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
        const normalized = text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join('\n')
        setText(normalized)
        onChange(normalized ? normalized.split('\n') : [])
      }}
      onChange={(e) => {
        setText(e.target.value)
        onChange(e.target.value.split('\n'))
      }}
      rows={7}
      placeholder="一行一条可执行事件：谁在哪做什么、冲突如何升级、结尾留什么钩子"
      className={textareaCls}
    />
  )
}

export default function PlanEditor({
  novel,
  vols,
  characters,
  seedForm,
  onSeedFormChange,
  selection,
  onNovelChange,
  onVolumeChange,
  onChapterChange,
  onAddVolume,
  onAddChapter,
  onSelect,
  onOpenAi,
  onHome,
}: Props) {
  const selectedVolume = useMemo(
    () =>
      selection.kind === 'master'
        ? null
        : vols.find((v) => v.vol.id === selection.volumeId) ?? null,
    [selection, vols],
  )

  const chapterContext = useMemo(
    () => (selection.kind === 'chapter' ? findChapter(vols, selection.chapterId) : null),
    [selection, vols],
  )

  const flat = useMemo(() => flatChapters(vols), [vols])
  const flatIndex = chapterContext
    ? flat.findIndex((x) => x.chapter.id === chapterContext.chapter.id)
    : -1
  const prev = flatIndex > 0 ? flat[flatIndex - 1] : null
  const next = flatIndex >= 0 && flatIndex + 1 < flat.length ? flat[flatIndex + 1] : null

  if (selection.kind === 'master') {
    const empty = !novel.masterOutline?.trim()
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-5 space-y-4">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">全书主线</h2>
          <span className="text-[10px] text-muted-foreground">核心冲突 · 成长线 · 关键转折 · 结局走向</span>
        </div>

        {empty ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/10 px-5 py-6">
            <p className="text-sm text-foreground font-medium">这本书还没有主线</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              先写你已有的想法、角色或世界观，留空的部分交给 AI 补全；提案采纳前不会改动任何内容。
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button
                onClick={() => onOpenAi('seed')}
                className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2.5 text-left text-xs text-violet-200 hover:bg-violet-500/15 transition-colors"
              >
                <Wand2 size={14} />
                <span>
                  <span className="block font-medium">AI 立项</span>
                  <span className="text-[10px] text-violet-300/70">先填想法 / 角色 / 世界观，AI 补全</span>
                </span>
              </button>
              <button
                onClick={onAddVolume}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left text-xs text-foreground hover:bg-muted/40 transition-colors"
              >
                <Layers size={14} />
                <span>
                  <span className="block font-medium">手动搭建</span>
                  <span className="text-[10px] text-muted-foreground">先建卷，再逐章填</span>
                </span>
              </button>
              <button
                onClick={onHome}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left text-xs text-foreground hover:bg-muted/40 transition-colors"
              >
                <BookOpen size={14} />
                <span>
                  <span className="block font-medium">使用模板</span>
                  <span className="text-[10px] text-muted-foreground">回首页新建时选模板</span>
                </span>
              </button>
            </div>
          </div>
        ) : (
          <Field label="主线文本" hint="Markdown 纯文本；保存后自动刷新大纲文件">
            <textarea
              value={novel.masterOutline ?? ''}
              onChange={(e) => onNovelChange({ masterOutline: e.target.value })}
              rows={16}
              placeholder="写清核心冲突、主角成长线、关键转折与结局走向。"
              className={textareaCls}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {['核心冲突', '成长线', '关键转折', '结局走向'].map((k) => (
            <div key={k} className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">{k}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground/60">写进主线文本即可</p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-border/40 bg-muted/10 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-foreground">
              <Users size={12} className="text-muted-foreground" />
              角色阵容
              <span className="text-[10px] text-muted-foreground">{characters.length} 位</span>
            </div>
            <button
              onClick={() => onHome()}
              className="text-[10px] text-muted-foreground hover:text-foreground"
              title="回首页后进入工作台，可在「设定」中管理角色"
            >
              去补充角色
            </button>
          </div>
          {characters.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground/70">还没有角色。可用左侧「立项孵化」生成，或在作品工作台补充。</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {characters.slice(0, 12).map((c) => (
                <span
                  key={c.id}
                  title={c.profile}
                  className="inline-flex h-6 items-center rounded-full border border-border/40 bg-muted/35 px-2 text-[11px] text-foreground/85"
                >
                  {c.name}
                  <span className="ml-1 text-[9px] text-muted-foreground">
                    {c.role === 'protagonist' ? '主角' : c.role === 'antagonist' ? '反派' : '配角'}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <SeedCluesCard
          novelId={novel.id}
          novel={novel}
          characters={characters}
          seedForm={seedForm}
          onSeedFormChange={onSeedFormChange}
          onOpenAi={onOpenAi}
        />
      </div>
    )
  }

  if (selection.kind === 'volume' && selectedVolume) {
    const { vol, chapters } = selectedVolume
    const written = chapters.filter((c) => c.wordCount > 0).length
    const missingHooks = chapters.filter((c) => c.wordCount === 0 && (c.hooks?.length ?? 0) === 0).length
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-5 space-y-4">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-primary" />
          <h2 className="text-sm font-semibold text-foreground">第{vol.order}卷</h2>
          <span className="text-[10px] text-muted-foreground">
            {chapters.length} 章 · 已写 {written} · 缺细纲 {missingHooks}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => onOpenAi('volume-chapters')}>
              <Sparkles size={11} className="mr-1" /> 生成本卷章纲
            </Button>
            <Button size="sm" variant="outline" onClick={() => onAddChapter(vol.id)}>
              <Plus size={11} className="mr-1" /> 添加章节
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="卷名">
            <input
              value={vol.title}
              onChange={(e) => onVolumeChange(vol.id, { title: e.target.value })}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="预计章数">
              <input
                type="number"
                min={0}
                value={vol.estimatedChapters ?? ''}
                onChange={(e) =>
                  onVolumeChange(vol.id, {
                    estimatedChapters: e.target.value ? Math.max(0, +e.target.value) : undefined,
                  })
                }
                placeholder="未设"
                className={inputCls}
              />
            </Field>
            <Field label="目标字数">
              <input
                type="number"
                min={0}
                step={1000}
                value={vol.targetWordCount ?? ''}
                onChange={(e) =>
                  onVolumeChange(vol.id, {
                    targetWordCount: e.target.value ? Math.max(0, +e.target.value) : undefined,
                  })
                }
                placeholder="未设"
                className={inputCls}
              />
            </Field>
          </div>
        </div>

        <Field label="卷纲" hint="本卷起止 · 主线推进 · 卷尾钩子">
          <textarea
            value={vol.summary}
            onChange={(e) => onVolumeChange(vol.id, { summary: e.target.value })}
            rows={5}
            placeholder="这一卷从哪里开始、推进什么、结尾把读者带到哪里。"
            className={textareaCls}
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="本卷目标">
            <textarea
              value={vol.goal ?? ''}
              onChange={(e) => onVolumeChange(vol.id, { goal: e.target.value })}
              rows={3}
              className={textareaCls}
            />
          </Field>
          <Field label="卷末高潮">
            <textarea
              value={vol.climax ?? ''}
              onChange={(e) => onVolumeChange(vol.id, { climax: e.target.value })}
              rows={3}
              className={textareaCls}
            />
          </Field>
          <Field label="卷尾钩子">
            <textarea
              value={vol.endingHook ?? ''}
              onChange={(e) => onVolumeChange(vol.id, { endingHook: e.target.value })}
              rows={3}
              className={textareaCls}
            />
          </Field>
        </div>

        <div className="rounded-xl border border-border/40">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <span className="text-xs font-medium text-foreground">本卷章节</span>
            <span className="text-[10px] text-muted-foreground">{chapters.length} 章</span>
          </div>
          {chapters.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              本卷还没有章节，先「生成本卷章纲」或手动添加。
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {chapters.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onSelect({ kind: 'chapter', volumeId: vol.id, chapterId: c.id })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/25 transition-colors"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full flex-shrink-0',
                      chapterDot(c) === 'written'
                        ? 'bg-emerald-400'
                        : chapterDot(c) === 'planned'
                          ? 'bg-sky-400'
                          : 'bg-zinc-600',
                    )}
                  />
                  <span className="w-7 flex-shrink-0 text-[11px] text-muted-foreground">{c.order}.</span>
                  <span className="flex-1 truncate text-xs text-foreground">{c.title || '未命名'}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {c.wordCount > 0 ? `${c.wordCount} 字` : c.targetWordCount ? `目标 ${c.targetWordCount}` : ''}
                  </span>
                  <span className="w-12 text-right text-[10px] text-muted-foreground">
                    {c.hooks?.length ? `${c.hooks.length} 钩` : '缺细纲'}
                  </span>
                  <ArrowRight size={11} className="text-muted-foreground/50" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (selection.kind === 'chapter' && chapterContext) {
    const { volume, chapter } = chapterContext
    const written = chapter.wordCount > 0
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-5 space-y-4">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-primary" />
          <span className="text-[10px] text-muted-foreground">
            第{volume.order}卷《{volume.title}》· 第{chapter.order}章
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {written ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">
                <Lock size={10} /> 已写章 · 细纲只读
              </span>
            ) : (
              <Button size="sm" variant="outline" onClick={() => onOpenAi('chapter-detail')}>
                <Sparkles size={11} className="mr-1" />
                {chapter.hooks?.length ? '换一批细纲' : 'AI 细化本章'}
              </Button>
            )}
          </div>
        </div>

        {written && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-300/90">
            <Lock size={12} className="mt-0.5 flex-shrink-0" />
            本章已有 {chapter.wordCount} 字正文。摘要与细纲不允许再改，避免规划覆盖既成事实；如需调整后续走向，请用「重订走向」。
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px_120px]">
          <Field label="章名">
            <input
              value={chapter.title}
              onChange={(e) => onChapterChange(chapter.id, { title: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="目标字数">
            <input
              type="number"
              min={500}
              max={20000}
              step={500}
              disabled={written}
              value={chapter.targetWordCount || ''}
              onChange={(e) =>
                onChapterChange(chapter.id, {
                  targetWordCount: e.target.value ? Math.max(500, Math.min(20000, +e.target.value)) : 3000,
                })
              }
              className={cn(inputCls, written && 'opacity-60')}
            />
          </Field>
          <Field label="状态">
            <select
              value={chapter.status}
              onChange={(e) =>
                onChapterChange(chapter.id, { status: e.target.value as Chapter['status'] })
              }
              className={inputCls}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="章摘要" hint="1~3 句：本章发生了什么、改变了什么">
          <textarea
            value={chapter.summary ?? ''}
            disabled={written}
            onChange={(e) => onChapterChange(chapter.id, { summary: e.target.value })}
            rows={3}
            placeholder="这一章结束后，局面和人物关系发生了什么变化。"
            className={cn(textareaCls, written && 'opacity-60')}
          />
        </Field>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-[11px] text-muted-foreground">
              细纲 hooks
              <span className="ml-1.5 text-muted-foreground/60">一行一条，可增删改</span>
            </label>
            {!written && (
              <button
                onClick={() => {
                  if (window.confirm('清空本章摘要与细纲？')) {
                    onChapterChange(chapter.id, { summary: '', hooks: [] })
                  }
                }}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-400"
              >
                <Trash2 size={10} /> 清空
              </button>
            )}
          </div>
          <HooksEditor
            chapter={chapter}
            disabled={written}
            onChange={(hooks) => onChapterChange(chapter.id, { hooks })}
          />
          {!written && (chapter.hooks?.length ?? 0) === 0 && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-400/80">
              <AlertTriangle size={10} /> 没有细纲时，流水线无法开写本章。
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[{ label: '上一章', item: prev }, { label: '下一章', item: next }].map(({ label, item }) => (
            <div key={label} className="rounded-lg border border-border/40 bg-muted/10 p-3">
              <p className="text-[10px] text-muted-foreground">{label}（只读）</p>
              {item ? (
                <>
                  <button
                    onClick={() =>
                      onSelect({
                        kind: 'chapter',
                        volumeId: item.volumeId,
                        chapterId: item.chapter.id,
                      })
                    }
                    className="mt-1 text-xs text-foreground hover:text-primary"
                  >
                    {item.chapter.title || '未命名'}
                  </button>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground/75">
                    {item.chapter.summary || item.chapter.hooks?.join('；') || '（暂无摘要与细纲）'}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-[10px] text-muted-foreground/60">（无）</p>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      <Loader2 size={14} className="mr-1.5 animate-spin" /> 正在定位节点…
    </div>
  )
}
