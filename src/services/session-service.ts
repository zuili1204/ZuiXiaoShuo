/**
 * 日更会话服务
 *
 * 记录「今天写了多少」：按保存前后的字数差累计净增量，按 10 分钟窗口
 * 合并为一条会话，追加到 content/stats/<novelId>/sessions.jsonl（只追加，不改写）。
 * 读取时按本地日期聚合，供日更驾驶舱展示今日/近 7 天/连续达标天数。
 *
 * 进程异常退出时，未落盘的会话草稿保存在 localStorage，
 * 下次启动补记一条 source: 'recovered' 的行（同一 id 只补一次）。
 */

import { getSetting, setSetting } from './settings-service'

const api = () => window.electronAPI

/** 同一编辑会话的合并窗口：10 分钟内连续保存合并为一条会话。 */
export const SESSION_WINDOW_MS = 10 * 60 * 1000
export const DEFAULT_DAILY_WORD_GOAL = 3000

export type SessionSource = 'manual' | 'ai' | 'pipeline' | 'recovered'

export interface SessionRecord {
  /** 会话行缺省；修正行为 'adjust' */
  type?: 'session' | 'adjust'
  id: string
  novelId: string
  chapterId?: string
  startedAt: string
  endedAt: string
  wordsAdded: number
  source: SessionSource
  model?: string | null
  /** 修正行可指定归属日期（YYYY-MM-DD），缺省按 endedAt 的本地日期 */
  date?: string
}

export interface DailyStat {
  date: string
  words: number
  chapters: number
  sessions: number
  bySource: Record<SessionSource, number>
}

export interface DailyStats {
  today: string
  todayWords: number
  goal: number
  streak: number
  week: DailyStat[]
  weekWords: number
  weekChapters: number
  /** 尚未落盘、但已计入今日的会话净增量 */
  pendingWords: number
}

export interface BacklogStats {
  chapters: number
  words: number
}

interface PendingSession {
  id: string
  novelId: string
  chapterId?: string
  startedAt: number
  lastActivity: number
  wordsAdded: number
  source: SessionSource
  model?: string | null
}

const pendingSessions = new Map<string, PendingSession>()
const writeQueues = new Map<string, Promise<unknown>>()

type SessionListener = (novelId: string) => void
const sessionListeners = new Set<SessionListener>()

/** 订阅会话变化（保存计入、落盘、修正），供驾驶舱即时刷新。 */
export function subscribeSessionChanges(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  return () => { sessionListeners.delete(listener) }
}

function notifySessionChanged(novelId: string): void {
  for (const listener of sessionListeners) {
    try {
      listener(novelId)
    } catch {
      // 单个订阅者异常不影响记录链路
    }
  }
}

const DRAFT_INDEX_KEY = 'zxs:session-drafts'

function draftKey(novelId: string): string {
  return `zxs:session-draft:${novelId}`
}

function statsPath(novelId: string): string {
  return `content/stats/${novelId}/sessions.jsonl`
}

function makeSessionId(now: number): string {
  return `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 本地日期键（YYYY-MM-DD），跨时区以用户本地日历为准。 */
export function toDateKey(value: number | string | Date = Date.now()): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function shiftDay(ts: number, delta: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + delta)
  return d.getTime()
}

// ===== 追加写（按小说串行，避免并发写丢行） =====

function enqueueWrite<T>(novelId: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(novelId) ?? Promise.resolve()
  const run = prev.then(task, task)
  writeQueues.set(
    novelId,
    run.catch(() => {})
  )
  return run
}

async function readStatsText(novelId: string): Promise<string> {
  try {
    const exists = await api()?.file?.exists?.(statsPath(novelId))
    if (!exists) return ''
    return await api().file.read(statsPath(novelId))
  } catch {
    return ''
  }
}

async function appendRecord(record: SessionRecord): Promise<void> {
  await enqueueWrite(record.novelId, async () => {
    const existing = await readStatsText(record.novelId)
    const line = JSON.stringify(record)
    const next = existing
      ? `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n`
      : `${line}\n`
    await api().file.write(statsPath(record.novelId), next)
  })
}

/** 读取全部会话行（坏行跳过；只追加日志不允许单行损坏拖垮整本统计）。 */
export async function loadSessionRecords(novelId: string): Promise<SessionRecord[]> {
  const raw = await readStatsText(novelId)
  if (!raw.trim()) return []
  const out: SessionRecord[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const row = JSON.parse(text)
      if (!row || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || typeof row.endedAt !== 'string') continue
      if (row.novelId && row.novelId !== novelId) continue
      const words = Number(row.wordsAdded)
      if (!Number.isFinite(words)) continue
      out.push({
        type: row.type === 'adjust' ? 'adjust' : undefined,
        id: row.id,
        novelId: row.novelId ?? novelId,
        chapterId: typeof row.chapterId === 'string' ? row.chapterId : undefined,
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : row.endedAt,
        endedAt: row.endedAt,
        wordsAdded: words,
        source: isSessionSource(row.source) ? row.source : 'manual',
        model: typeof row.model === 'string' ? row.model : null,
        date: typeof row.date === 'string' ? row.date : undefined,
      })
    } catch {
      // 单行损坏：跳过，不影响其余历史
    }
  }
  return out
}

function isSessionSource(v: unknown): v is SessionSource {
  return v === 'manual' || v === 'ai' || v === 'pipeline' || v === 'recovered'
}

// ===== 草稿（异常退出补记） =====

function persistDraft(pending: PendingSession): void {
  try {
    localStorage.setItem(draftKey(pending.novelId), JSON.stringify(pending))
    const ids = readDraftIndex()
    if (!ids.includes(pending.novelId)) {
      ids.push(pending.novelId)
      localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(ids))
    }
  } catch {
    // localStorage 不可用时静默降级：仅失去异常退出补记能力
  }
}

function clearDraft(novelId: string): void {
  try {
    localStorage.removeItem(draftKey(novelId))
    const ids = readDraftIndex().filter((id) => id !== novelId)
    localStorage.setItem(DRAFT_INDEX_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

function readDraftIndex(): string[] {
  try {
    const raw = localStorage.getItem(DRAFT_INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function readDraft(novelId: string): PendingSession | null {
  try {
    const raw = localStorage.getItem(draftKey(novelId))
    if (!raw) return null
    const row = JSON.parse(raw)
    if (!row || typeof row !== 'object') return null
    if (typeof row.id !== 'string') return null
    const words = Number(row.wordsAdded)
    if (!Number.isFinite(words)) return null
    return {
      id: row.id,
      novelId,
      chapterId: typeof row.chapterId === 'string' ? row.chapterId : undefined,
      startedAt: Number(row.startedAt) || Date.now(),
      lastActivity: Number(row.lastActivity) || Date.now(),
      wordsAdded: words,
      source: isSessionSource(row.source) ? row.source : 'manual',
      model: typeof row.model === 'string' ? row.model : null,
    }
  } catch {
    return null
  }
}

// ===== 记录与落盘 =====

/**
 * 记录一次正文保存的净字数变化。
 * before/after 是保存前后的章节字数；差值为 0 时忽略。
 */
export async function recordChapterSave(
  novelId: string,
  chapterId: string,
  beforeWords: number,
  afterWords: number,
  opts: { source?: SessionSource; model?: string | null; now?: number } = {}
): Promise<void> {
  try {
    const before = Math.round(Number(beforeWords) || 0)
    const after = Math.round(Number(afterWords) || 0)
    const delta = after - before
    if (!delta) return

    const source = opts.source ?? 'manual'
    const now = opts.now ?? Date.now()

    let pending = pendingSessions.get(novelId)
    if (pending && (pending.source !== source || now - pending.lastActivity > SESSION_WINDOW_MS)) {
      await flushSession(novelId, pending.lastActivity)
      pending = undefined
    }
    if (!pending) {
      pending = {
        id: makeSessionId(now),
        novelId,
        startedAt: now,
        lastActivity: now,
        wordsAdded: 0,
        source,
        model: opts.model ?? null,
      }
      pendingSessions.set(novelId, pending)
    }
    pending.wordsAdded += delta
    pending.chapterId = chapterId
    pending.lastActivity = now
    if (opts.model) pending.model = opts.model
    persistDraft(pending)
    notifySessionChanged(novelId)
  } catch (e) {
    console.error('[session] recordChapterSave failed:', e)
  }
}

/**
 * 结束当前会话并追加一行。
 * 返回写入的记录；没有待落盘内容时返回 null。
 */
export async function flushSession(novelId: string, now = Date.now()): Promise<SessionRecord | null> {
  const pending = pendingSessions.get(novelId)
  if (!pending) return null
  pendingSessions.delete(novelId)

  if (!pending.wordsAdded) {
    clearDraft(novelId)
    notifySessionChanged(novelId)
    return null
  }

  const record: SessionRecord = {
    id: pending.id,
    novelId,
    chapterId: pending.chapterId,
    startedAt: new Date(pending.startedAt).toISOString(),
    endedAt: new Date(now).toISOString(),
    wordsAdded: pending.wordsAdded,
    source: pending.source,
    model: pending.model ?? null,
  }

  try {
    await appendRecord(record)
    clearDraft(novelId)
    notifySessionChanged(novelId)
    return record
  } catch (e) {
    console.error('[session] flushSession failed:', e)
    // 写失败时恢复待落盘状态，下次保存/启动继续补记
    pendingSessions.set(novelId, pending)
    persistDraft(pending)
    return null
  }
}

/** 结束全部会话（应用退出前调用；失败时保留草稿供下次补记）。 */
export async function flushAllSessions(now = Date.now()): Promise<void> {
  const ids = Array.from(pendingSessions.keys())
  await Promise.all(ids.map((id) => flushSession(id, now)))
}

/** 追加一条修正行（历史只追加不改写）。 */
export async function appendAdjustment(
  novelId: string,
  wordsDelta: number,
  opts: { date?: string; chapterId?: string; now?: number } = {}
): Promise<void> {
  const now = opts.now ?? Date.now()
  await appendRecord({
    type: 'adjust',
    id: `adj_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    novelId,
    chapterId: opts.chapterId,
    startedAt: new Date(now).toISOString(),
    endedAt: new Date(now).toISOString(),
    wordsAdded: wordsDelta,
    source: 'manual',
    date: opts.date ?? toDateKey(now),
  })
  notifySessionChanged(novelId)
}

/**
 * 补记异常退出时未落盘的会话。
 * 同一会话 id 已存在于日志时跳过，避免与应用退出前的正常落盘重复。
 */
export async function recoverPendingSession(novelId: string, now = Date.now()): Promise<boolean> {
  if (pendingSessions.has(novelId)) return false
  const draft = readDraft(novelId)
  if (!draft) {
    clearDraft(novelId)
    return false
  }
  if (!draft.wordsAdded) {
    clearDraft(novelId)
    return false
  }

  try {
    const existing = await loadSessionRecords(novelId)
    if (existing.some((r) => r.id === draft.id)) {
      clearDraft(novelId)
      return false
    }
    await appendRecord({
      id: draft.id,
      novelId,
      chapterId: draft.chapterId,
      startedAt: new Date(draft.startedAt).toISOString(),
      endedAt: new Date(Math.min(draft.lastActivity, now)).toISOString(),
      wordsAdded: draft.wordsAdded,
      source: 'recovered',
      model: draft.model ?? null,
    })
    clearDraft(novelId)
    notifySessionChanged(novelId)
    return true
  } catch (e) {
    console.error('[session] recoverPendingSession failed:', e)
    return false
  }
}

/** 启动时补记所有小说的异常退出会话。 */
export async function recoverAllPendingSessions(now = Date.now()): Promise<number> {
  const ids = readDraftIndex()
  let recovered = 0
  for (const id of ids) {
    if (await recoverPendingSession(id, now)) recovered++
  }
  return recovered
}

// ===== 目标 / 已发布章 =====

export function dailyWordGoalKey(novelId: string): string {
  return `novel:${novelId}:dailyWordGoal`
}

export function publishedChapterKey(novelId: string): string {
  return `novel:${novelId}:publishedChapter`
}

export async function getDailyWordGoal(novelId: string): Promise<number> {
  const goal = await getSetting<number>(dailyWordGoalKey(novelId), DEFAULT_DAILY_WORD_GOAL)
  return Number.isFinite(goal) && goal > 0 ? goal : DEFAULT_DAILY_WORD_GOAL
}

export async function setDailyWordGoal(novelId: string, goal: number): Promise<void> {
  const safe = Math.max(0, Math.round(Number(goal) || 0))
  await setSetting(dailyWordGoalKey(novelId), safe)
}

export async function getPublishedChapter(novelId: string): Promise<number> {
  const n = await getSetting<number>(publishedChapterKey(novelId), 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export async function setPublishedChapter(novelId: string, chapter: number): Promise<void> {
  await setSetting(publishedChapterKey(novelId), Math.max(0, Math.floor(Number(chapter) || 0)))
}

// ===== 聚合 =====

function emptyBySource(): Record<SessionSource, number> {
  return { manual: 0, ai: 0, pipeline: 0, recovered: 0 }
}

interface DayAccumulator {
  words: number
  chapterIds: Set<string>
  sessions: number
  bySource: Record<SessionSource, number>
}

function accumulate(map: Map<string, DayAccumulator>, record: SessionRecord): void {
  const key = record.date || toDateKey(record.endedAt)
  if (!key) return
  let day = map.get(key)
  if (!day) {
    day = { words: 0, chapterIds: new Set(), sessions: 0, bySource: emptyBySource() }
    map.set(key, day)
  }
  day.words += record.wordsAdded
  day.bySource[record.source] += record.wordsAdded
  if (record.type !== 'adjust') day.sessions += 1
  if (record.chapterId && record.wordsAdded !== 0) day.chapterIds.add(record.chapterId)
}

function computeStreak(totals: Map<string, DayAccumulator>, goal: number, now: number): number {
  if (goal <= 0) return 0
  let cursor = dayStart(now)
  const todayMet = (totals.get(toDateKey(cursor))?.words ?? 0) >= goal
  if (!todayMet) cursor = shiftDay(cursor, -1)

  let streak = 0
  // 上限 3650 天，避免异常数据导致死循环
  for (let i = 0; i < 3650; i++) {
    const words = totals.get(toDateKey(cursor))?.words ?? 0
    if (words < goal) break
    streak++
    cursor = shiftDay(cursor, -1)
  }
  return streak
}

/**
 * 读取今日 / 近 7 天 / 连续达标天数。
 * 今日统计包含尚未落盘的内存会话，保存后立即可见。
 */
export async function getDailyStats(
  novelId: string,
  opts: { now?: number; days?: number } = {}
): Promise<DailyStats> {
  const now = opts.now ?? Date.now()
  const days = Math.max(1, Math.min(31, Math.floor(opts.days ?? 7)))
  const goal = await getDailyWordGoal(novelId)

  const totals = new Map<string, DayAccumulator>()
  const records = await loadSessionRecords(novelId)
  for (const record of records) accumulate(totals, record)

  const pending = pendingSessions.get(novelId)
  let pendingWords = 0
  if (pending) {
    pendingWords = pending.wordsAdded
    accumulate(totals, {
      id: pending.id,
      novelId,
      chapterId: pending.chapterId,
      startedAt: new Date(pending.startedAt).toISOString(),
      endedAt: new Date(pending.lastActivity).toISOString(),
      wordsAdded: pending.wordsAdded,
      source: pending.source,
      model: pending.model ?? null,
    })
  }

  const today = toDateKey(now)
  const week: DailyStat[] = []
  const weekChapterIds = new Set<string>()
  for (let i = days - 1; i >= 0; i--) {
    const key = toDateKey(shiftDay(dayStart(now), -i))
    const day = totals.get(key)
    const chapterCount = day?.chapterIds.size ?? 0
    if (day) for (const id of day.chapterIds) weekChapterIds.add(id)
    week.push({
      date: key,
      words: day?.words ?? 0,
      chapters: chapterCount,
      sessions: day?.sessions ?? 0,
      bySource: day?.bySource ?? emptyBySource(),
    })
  }

  return {
    today,
    todayWords: totals.get(today)?.words ?? 0,
    goal,
    streak: computeStreak(totals, goal, now),
    week,
    weekWords: week.reduce((sum, d) => sum + d.words, 0),
    weekChapters: weekChapterIds.size,
    pendingWords,
  }
}

/**
 * 存稿统计：已定稿且全局序号大于「已发布章」的章节。
 * chapters 需按卷序 + 卷内章节序拍平（调用方保证顺序）。
 */
export function computeBacklog(
  chapters: Array<{ status: string; wordCount: number }>,
  publishedChapter: number
): BacklogStats {
  const published = Math.max(0, Math.floor(Number(publishedChapter) || 0))
  let count = 0
  let words = 0
  chapters.forEach((ch, idx) => {
    if (idx + 1 <= published) return
    if (ch.status !== 'final') return
    count++
    words += Number(ch.wordCount) || 0
  })
  return { chapters: count, words }
}
