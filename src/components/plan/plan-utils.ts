import type { Chapter, Character, Novel, OutlineSeed } from '@shared/types'
import type { VolChap } from '@/services/ai-outline'

export type PlanSelection =
  | { kind: 'master' }
  | { kind: 'volume'; volumeId: string }
  | { kind: 'chapter'; volumeId: string; chapterId: string }

export type PlanMode =
  | 'seed'
  | 'master'
  | 'volume-chapters'
  | 'chapter-detail'
  | 'review'
  | 'calibrate'

export const PLAN_MODES: { id: PlanMode; label: string; scope: string; desc: string }[] = [
  { id: 'seed', label: '立项孵化', scope: '全书', desc: '补全书名、类型、梗概与角色阵容' },
  { id: 'master', label: '主线分卷', scope: '全书', desc: '生成全书主线与分卷规划' },
  { id: 'volume-chapters', label: '卷章纲', scope: '当前卷', desc: '为当前卷生成章名与一句话骨架' },
  { id: 'chapter-detail', label: '章细纲', scope: '当前章', desc: '把章骨架细化为可开写的摘要与 hooks' },
  { id: 'review', label: '大纲体检', scope: '全书', desc: '找出节奏、逻辑与连贯性问题' },
  { id: 'calibrate', label: '重订走向', scope: '全书', desc: '按已写事实校正未写章走向' },
]

export interface PlanChecklistItem {
  key: string
  label: string
  done: boolean
  hint?: string
}

/** 立项素材：作者可只填任意字段，也可全留空让 AI 从零提案 */
export interface SeedForm {
  genre: string
  title: string
  premise: string
  coreConflict: string
  protagonist: string
  characters: string
  worldview: string
  setting: string
  power: string
  sellingPoints: string
  tone: string
  references: string
  taboos: string
  /** 草稿区：随手写，AI 规划时一并参考 */
  draft: string
  volCount: string
  chCount: string
}

export const emptySeedForm = (): SeedForm => ({
  genre: '',
  title: '',
  premise: '',
  coreConflict: '',
  protagonist: '',
  characters: '',
  worldview: '',
  setting: '',
  power: '',
  sellingPoints: '',
  tone: '',
  references: '',
  taboos: '',
  draft: '',
  volCount: '',
  chCount: '',
})

export const roleLabel = (role: string) =>
  role === 'protagonist' ? '主角' : role === 'antagonist' ? '反派' : '配角'

const characterLine = (c: Character) =>
  `${c.name}（${roleLabel(c.role)}）${c.profile ? ` —— ${c.profile}` : ''}`

/** 主角单独成块，其余角色进「其他角色」；两边合并后才是完整角色线索 */
export function seedCharactersText(form: SeedForm): string {
  return [form.protagonist.trim(), form.characters.trim()].filter(Boolean).join('\n')
}

export function seedFormFrom(novel: Novel, characters: Character[]): SeedForm {
  const protagonist = characters.find((c) => c.role === 'protagonist') ?? null
  const others = protagonist ? characters.filter((c) => c.id !== protagonist.id) : characters
  return {
    ...emptySeedForm(),
    genre: novel.genre?.join(' / ') ?? '',
    title: novel.title ?? '',
    premise: novel.description ?? '',
    protagonist: protagonist
      ? `${protagonist.name}${protagonist.profile ? ` —— ${protagonist.profile}` : ''}`
      : '',
    characters: others.map(characterLine).join('\n'),
  }
}

/** 表单 → 规划输入：空字段不传，避免占位文本干扰 AI */
export function seedOutlineFrom(form: SeedForm): OutlineSeed {
  const text = (v: string) => v.trim() || undefined
  return {
    title: text(form.title),
    genre: text(form.genre),
    premise: text(form.premise),
    coreConflict: text(form.coreConflict),
    protagonist: text(form.protagonist),
    characters: text(form.characters),
    worldview: text(form.worldview),
    setting: text(form.setting),
    power: text(form.power),
    sellingPoints: text(form.sellingPoints),
    tone: text(form.tone),
    references: text(form.references),
    taboos: text(form.taboos),
    draft: text(form.draft),
    volumeCount: +form.volCount > 0 ? +form.volCount : undefined,
    chapterCount: +form.chCount > 0 ? +form.chCount : undefined,
  }
}

export function allChapters(vols: VolChap[]): Chapter[] {
  return vols.flatMap((v) => v.chapters)
}

export function missingHooksCount(vols: VolChap[]): number {
  // 流水线只认 hooks（摘要不算锚点），这里必须同口径
  return allChapters(vols).filter(
    (c) => c.wordCount === 0 && (c.hooks?.length ?? 0) === 0,
  ).length
}

export function computePlanChecklist(
  novel: Novel | null,
  vols: VolChap[],
  characters: Character[],
): PlanChecklistItem[] {
  const chapters = allChapters(vols)
  const firstVolume = vols[0]
  const missing = missingHooksCount(vols)
  return [
    { key: 'master', label: '已写全书主线', done: !!novel?.masterOutline?.trim() },
    { key: 'volumes', label: '至少规划 1 卷', done: vols.length > 0 },
    {
      key: 'volume-summary',
      label: '每卷都有卷纲',
      done: vols.length > 0 && vols.every((v) => !!v.vol.summary?.trim()),
    },
    { key: 'first-chapters', label: '首卷已有章纲', done: (firstVolume?.chapters.length ?? 0) > 0 },
    {
      key: 'hooks',
      label: '未写章都有细纲',
      done: chapters.length > 0 && missing === 0,
      hint: missing > 0 ? `${missing} 章仍缺细纲` : undefined,
    },
    { key: 'characters', label: '已建立主要角色', done: characters.length > 0 },
    { key: 'chapters', label: '全书至少 1 章', done: chapters.length > 0 },
  ]
}

export function checklistPercent(items: PlanChecklistItem[]): number {
  if (items.length === 0) return 0
  return Math.round((items.filter((i) => i.done).length / items.length) * 100)
}

export function isPlanReady(items: PlanChecklistItem[]): boolean {
  return items.length > 0 && items.every((i) => i.done)
}

export type ChapterDot = 'written' | 'planned' | 'empty'

export function chapterDot(ch: Chapter): ChapterDot {
  if (ch.wordCount > 0) return 'written'
  if ((ch.hooks?.length ?? 0) > 0) return 'planned'
  return 'empty'
}

export function flatChapters(vols: VolChap[]): { chapter: Chapter; volumeId: string; volumeTitle: string }[] {
  return vols.flatMap((v) =>
    v.chapters.map((chapter) => ({ chapter, volumeId: v.vol.id, volumeTitle: v.vol.title })),
  )
}

export function findChapter(vols: VolChap[], chapterId: string) {
  for (const v of vols) {
    const chapter = v.chapters.find((c) => c.id === chapterId)
    if (chapter) return { volume: v.vol, chapter, siblings: v.chapters }
  }
  return null
}

export const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewed: '已审',
  polished: '精修',
  final: '定稿',
}

export const STATUS_OPTIONS: { value: Chapter['status']; label: string }[] = [
  { value: 'draft', label: '草稿' },
  { value: 'reviewed', label: '已审' },
  { value: 'polished', label: '精修' },
  { value: 'final', label: '定稿' },
]
