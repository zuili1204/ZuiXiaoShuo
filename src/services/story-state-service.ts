/**
 * P1 Story State 服务：角色状态快照 / 时间线事件 / 剧情线。
 *
 * - 角色状态与时间线只追加，最新一章即当前状态；
 * - 剧情线聚合现有 foreshadowings，负责老化与回收计划；
 * - 迁移使用确定性 id + INSERT OR IGNORE，可重复执行。
 */
import type {
  CharacterState,
  Chapter,
  Character,
  CharacterKnowledge,
  Foreshadowing,
  PlotThread,
  PlotThreadKind,
  PlotThreadStatus,
  TimelineEvent,
  TimelineEventKind,
} from '@shared/types'

const api = () => window.electronAPI

function safeParse<T>(raw: unknown, fallback: T): T {
  if (raw == null || raw === '') return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function rowToCharacterState(row: any): CharacterState {
  return {
    id: row.id,
    novelId: row.novel_id,
    characterId: row.character_id,
    chapterId: row.chapter_id,
    chapterOrder: Number(row.chapter_order) || 0,
    location: row.location ?? '',
    knowledge: safeParse<CharacterKnowledge>(row.knowledge_json, { knows: [], suspects: [], unaware: [] }),
    items: safeParse(row.items_json, []),
    abilities: safeParse(row.abilities_json, []),
    relationships: safeParse(row.relationships_json, []),
    status: row.status ?? 'active',
    note: row.note ?? '',
    createdAt: row.created_at,
  }
}

function rowToTimelineEvent(row: any): TimelineEvent {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    chapterOrder: Number(row.chapter_order) || 0,
    storyTime: row.story_time ?? '',
    event: row.event ?? '',
    location: row.location ?? '',
    characters: safeParse(row.characters_json, []),
    kind: row.kind ?? 'plot',
    source: row.source ?? 'author',
    createdAt: row.created_at,
  }
}

function rowToPlotThread(row: any): PlotThread {
  return {
    id: row.id,
    novelId: row.novel_id,
    title: row.title ?? '',
    kind: row.kind ?? 'foreshadow',
    status: row.status ?? 'open',
    plantedChapter: row.planted_chapter ?? undefined,
    plannedResolveChapter: row.planned_resolve_chapter ?? undefined,
    resolvedChapter: row.resolved_chapter ?? undefined,
    urgency: Number(row.urgency) || 1,
    lastTouchedChapter: row.last_touched_chapter ?? undefined,
    payoffPlan: row.payoff_plan ?? '',
    foreshadowingIds: safeParse(row.foreshadowing_ids_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ===== 角色状态 =====

export async function listCharacterStates(novelId: string): Promise<CharacterState[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM character_states WHERE novel_id = ? ORDER BY chapter_order ASC, created_at ASC',
      [novelId]
    )) as any[]
    return rows.map(rowToCharacterState)
  } catch (e) {
    console.error('[story-state] listCharacterStates failed:', e)
    return []
  }
}

/** 某角色按章状态时间线。 */
export async function listCharacterStateTimeline(
  novelId: string,
  characterId: string
): Promise<CharacterState[]> {
  const all = await listCharacterStates(novelId)
  return all.filter((s) => s.characterId === characterId)
}

/**
 * 每个角色在指定章（含）之前的最新状态；不传 chapterOrder 取全书最新。
 * 同一章多条时取最后创建的。
 */
export function latestCharacterStates(states: CharacterState[], chapterOrder?: number): CharacterState[] {
  const latest = new Map<string, CharacterState>()
  for (const s of states) {
    if (chapterOrder != null && s.chapterOrder > chapterOrder) continue
    const prev = latest.get(s.characterId)
    if (!prev || s.chapterOrder > prev.chapterOrder || (s.chapterOrder === prev.chapterOrder && s.createdAt >= prev.createdAt)) {
      latest.set(s.characterId, s)
    }
  }
  return Array.from(latest.values())
}

export async function saveCharacterState(
  input: Omit<CharacterState, 'id' | 'createdAt'> & { id?: string; createdAt?: string }
): Promise<CharacterState> {
  const state: CharacterState = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
  await api().db.query(
    `INSERT INTO character_states
      (id, novel_id, character_id, chapter_id, chapter_order, location, knowledge_json, items_json,
       abilities_json, relationships_json, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       location=excluded.location,
       knowledge_json=excluded.knowledge_json,
       items_json=excluded.items_json,
       abilities_json=excluded.abilities_json,
       relationships_json=excluded.relationships_json,
       status=excluded.status,
       note=excluded.note`,
    [
      state.id,
      state.novelId,
      state.characterId,
      state.chapterId,
      state.chapterOrder,
      state.location,
      JSON.stringify(state.knowledge),
      JSON.stringify(state.items),
      JSON.stringify(state.abilities),
      JSON.stringify(state.relationships),
      state.status,
      state.note,
      state.createdAt,
    ]
  )
  return state
}

export async function deleteCharacterState(id: string): Promise<void> {
  await api().db.query('DELETE FROM character_states WHERE id = ?', [id])
}

// ===== 时间线 =====

export async function listTimelineEvents(novelId: string): Promise<TimelineEvent[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM timeline_events WHERE novel_id = ? ORDER BY chapter_order ASC, created_at ASC',
      [novelId]
    )) as any[]
    return rows.map(rowToTimelineEvent)
  } catch (e) {
    console.error('[story-state] listTimelineEvents failed:', e)
    return []
  }
}

export async function saveTimelineEvent(
  input: Omit<TimelineEvent, 'id' | 'createdAt'> & { id?: string; createdAt?: string }
): Promise<TimelineEvent> {
  const event: TimelineEvent = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
  await api().db.query(
    `INSERT INTO timeline_events
      (id, novel_id, chapter_id, chapter_order, story_time, event, location, characters_json, kind, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       story_time=excluded.story_time,
       event=excluded.event,
       location=excluded.location,
       characters_json=excluded.characters_json,
       kind=excluded.kind,
       source=excluded.source`,
    [
      event.id,
      event.novelId,
      event.chapterId,
      event.chapterOrder,
      event.storyTime,
      event.event,
      event.location,
      JSON.stringify(event.characters),
      event.kind,
      event.source,
      event.createdAt,
    ]
  )
  return event
}

export async function deleteTimelineEvent(id: string): Promise<void> {
  await api().db.query('DELETE FROM timeline_events WHERE id = ?', [id])
}

// ===== 剧情线 =====

export async function listPlotThreads(novelId: string): Promise<PlotThread[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM plot_threads WHERE novel_id = ? ORDER BY urgency DESC, COALESCE(planted_chapter, 0) ASC',
      [novelId]
    )) as any[]
    return rows.map(rowToPlotThread)
  } catch (e) {
    console.error('[story-state] listPlotThreads failed:', e)
    return []
  }
}

export async function savePlotThread(
  input: Omit<PlotThread, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string
    createdAt?: string
    updatedAt?: string
  }
): Promise<PlotThread> {
  const now = new Date().toISOString()
  const thread: PlotThread = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
  await api().db.query(
    `INSERT INTO plot_threads
      (id, novel_id, title, kind, status, planted_chapter, planned_resolve_chapter, resolved_chapter,
       urgency, last_touched_chapter, payoff_plan, foreshadowing_ids_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title,
       kind=excluded.kind,
       status=excluded.status,
       planted_chapter=excluded.planted_chapter,
       planned_resolve_chapter=excluded.planned_resolve_chapter,
       resolved_chapter=excluded.resolved_chapter,
       urgency=excluded.urgency,
       last_touched_chapter=excluded.last_touched_chapter,
       payoff_plan=excluded.payoff_plan,
       foreshadowing_ids_json=excluded.foreshadowing_ids_json,
       updated_at=excluded.updated_at`,
    [
      thread.id,
      thread.novelId,
      thread.title,
      thread.kind,
      thread.status,
      thread.plantedChapter ?? null,
      thread.plannedResolveChapter ?? null,
      thread.resolvedChapter ?? null,
      thread.urgency,
      thread.lastTouchedChapter ?? null,
      thread.payoffPlan,
      JSON.stringify(thread.foreshadowingIds),
      thread.createdAt,
      thread.updatedAt,
    ]
  )
  return thread
}

export async function deletePlotThread(id: string): Promise<void> {
  await api().db.query('DELETE FROM plot_threads WHERE id = ?', [id])
}

// ===== 风险计算（纯函数，供检查器/UI 共用） =====

export interface ThreadRisk {
  thread: PlotThread
  severity: 'warning' | 'critical'
  reasons: string[]
}

/**
 * 剧情线风险：主线计划回收章已过 → critical；任意开放线逾期未触碰 → warning；
 * 回收章早于埋设章 → warning（错序）。
 */
export function computeThreadRisks(
  threads: PlotThread[],
  currentChapter: number,
  staleAfter = 20
): ThreadRisk[] {
  const risks: ThreadRisk[] = []
  for (const t of threads) {
    if (t.status === 'resolved' || t.status === 'abandoned') continue
    const reasons: string[] = []
    let severity: ThreadRisk['severity'] = 'warning'

    if (t.plannedResolveChapter != null && currentChapter > t.plannedResolveChapter) {
      reasons.push(`计划第${t.plannedResolveChapter}章回收，已逾期 ${currentChapter - t.plannedResolveChapter} 章`)
      if (t.kind === 'main') severity = 'critical'
    }
    const lastTouched = t.lastTouchedChapter ?? t.plantedChapter
    if (lastTouched != null && currentChapter - lastTouched > staleAfter) {
      reasons.push(`已 ${currentChapter - lastTouched} 章未推进`)
    }
    if (t.resolvedChapter != null && t.plantedChapter != null && t.resolvedChapter < t.plantedChapter) {
      reasons.push('回收章早于埋设章（错序）')
    }
    if (reasons.length) risks.push({ thread: t, severity, reasons })
  }
  return risks
}

// ===== 幂等迁移 =====

export interface StoryStateMigrationResult {
  characterStates: number
  timelineEvents: number
  plotThreads: number
}

const MIGRATED_CHAPTER = '__migrated__'

async function insertIgnoreCharacterState(
  novelId: string,
  character: Character,
  chapterId: string,
  chapterOrder: number
): Promise<void> {
  await api().db.query(
    `INSERT OR IGNORE INTO character_states
      (id, novel_id, character_id, chapter_id, chapter_order, location, knowledge_json, items_json,
       abilities_json, relationships_json, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, '', '{}', '[]', '[]', '[]', 'active', ?, ?)`,
    [`cs_mig_${character.id}`, novelId, character.id, chapterId, chapterOrder, character.dynamicState ?? '', new Date().toISOString()]
  )
}

/**
 * 旧项目迁移（幂等）：
 * - characters.dynamic_state → 一条角色状态（chapter_order 取当前定位或 0）
 * - tracking.timelineAuthor → timeline_events（source=author）
 * - foreshadowings → kind=foreshadow 的剧情线（确定性 id）
 */
export async function ensureStoryStateMigrated(
  novelId: string,
  context: { characters: Character[]; foreshadowings: Foreshadowing[]; currentChapterOrder?: number }
): Promise<StoryStateMigrationResult> {
  const result: StoryStateMigrationResult = { characterStates: 0, timelineEvents: 0, plotThreads: 0 }
  const order = context.currentChapterOrder ?? 0

  for (const c of context.characters) {
    if (!c.dynamicState?.trim()) continue
    try {
      await insertIgnoreCharacterState(novelId, c, MIGRATED_CHAPTER, order)
      result.characterStates++
    } catch (e) {
      console.warn('[story-state] migrate character state failed:', e)
    }
  }

  // tracking.timelineAuthor → timeline_events
  try {
    const exists = await api().file.exists(`content/tracking/${novelId}.json`)
    if (exists) {
      const raw = await api().file.read(`content/tracking/${novelId}.json`)
      const state = raw ? JSON.parse(raw) : null
      const entries = Array.isArray(state?.timelineAuthor) ? state.timelineAuthor : []
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!e?.event) continue
        await api().db.query(
          `INSERT OR IGNORE INTO timeline_events
            (id, novel_id, chapter_id, chapter_order, story_time, event, location, characters_json, kind, source, created_at)
           VALUES (?, ?, ?, ?, '', ?, '', '[]', 'plot', 'author', ?)`,
          [`tl_mig_${novelId}_${e.chapter ?? 0}_${i}`, novelId, MIGRATED_CHAPTER, Number(e.chapter) || 0, String(e.event), new Date().toISOString()]
        )
        result.timelineEvents++
      }
    }
  } catch (e) {
    console.warn('[story-state] migrate timeline failed:', e)
  }

  for (const f of context.foreshadowings) {
    try {
      const status: PlotThreadStatus =
        f.status === 'resolved' ? 'resolved' : f.status === 'partial' ? 'partial' : 'open'
      const now = new Date().toISOString()
      await api().db.query(
        `INSERT OR IGNORE INTO plot_threads
          (id, novel_id, title, kind, status, planted_chapter, planned_resolve_chapter, resolved_chapter,
           urgency, last_touched_chapter, payoff_plan, foreshadowing_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 'foreshadow', ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        [
          `pt_fs_${f.id}`,
          novelId,
          f.content,
          status,
          f.plantedChapter ?? null,
          f.plannedResolveChapter ?? null,
          f.resolvedChapter ?? null,
          f.importance === 'major' ? 3 : 1,
          f.resolvedChapter ?? f.plantedChapter ?? null,
          JSON.stringify([f.id]),
          now,
          now,
        ]
      )
      result.plotThreads++
    } catch (e) {
      console.warn('[story-state] migrate plot thread failed:', e)
    }
  }

  return result
}

/** 章节/书名变更后的清理（章节删除不级联新表，避免误删跨章时间线）。 */
export async function clearStoryStateForNovel(novelId: string): Promise<void> {
  await api().db.query('DELETE FROM character_states WHERE novel_id = ?', [novelId])
  await api().db.query('DELETE FROM timeline_events WHERE novel_id = ?', [novelId])
  await api().db.query('DELETE FROM plot_threads WHERE novel_id = ?', [novelId])
}

export async function clearStoryStateForChapter(novelId: string, chapterId: string): Promise<void> {
  await api().db.query('DELETE FROM character_states WHERE novel_id = ? AND chapter_id = ?', [novelId, chapterId])
  await api().db.query('DELETE FROM timeline_events WHERE novel_id = ? AND chapter_id = ?', [novelId, chapterId])
}

/** 角色删除时清理其跨章状态（迁移态与手工态都不再成立）。 */
export async function clearStoryStateForCharacter(novelId: string, characterId: string): Promise<void> {
  await api().db.query('DELETE FROM character_states WHERE novel_id = ? AND character_id = ?', [novelId, characterId])
}

// 供 UI 构造新线程时的默认值
export function createPlotThreadDraft(novelId: string, kind: PlotThreadKind = 'sub'): PlotThread {
  const now = new Date().toISOString()
  return {
    id: '',
    novelId,
    title: '',
    kind,
    status: 'open',
    urgency: kind === 'main' ? 5 : 2,
    payoffPlan: '',
    foreshadowingIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

const PLOT_KIND_LABELS: Record<PlotThreadKind, string> = {
  main: '主线',
  sub: '支线',
  foreshadow: '伏笔',
  romance: '感情线',
}

const PLOT_STATUS_LABELS: Record<PlotThreadStatus, string> = {
  open: '进行中',
  partial: '部分回收',
  resolved: '已回收',
  abandoned: '已放弃',
}

/**
 * 生成注入 AI 上下文的紧凑状态摘要：只取当前章及之前的快照与时间线，
 * 避免未来章节的事实提前泄漏。
 */
export function buildStoryStateBrief(input: {
  states: CharacterState[]
  events: TimelineEvent[]
  threads: PlotThread[]
  chapterOrder: number
  names: Record<string, string>
  eventLimit?: number
}): string {
  const sections: string[] = []

  const latest = latestCharacterStates(input.states, input.chapterOrder)
  if (latest.length) {
    const lines = latest.map((s) => {
      const name = input.names[s.characterId] || s.characterId
      const parts = [`状态 ${s.status === 'active' ? '在场' : s.status === 'dead' ? '死亡' : s.status === 'missing' ? '失踪' : '退场'}`]
      if (s.location) parts.push(`位置 ${s.location}`)
      if (s.items.length) parts.push(`持有 ${s.items.map((i) => i.name).join('、')}`)
      if (s.abilities.length) parts.push(`能力 ${s.abilities.map((a) => a.name).join('、')}`)
      if (s.knowledge.knows.length) parts.push(`已知 ${s.knowledge.knows.join('、')}`)
      return `- ${name}：${parts.join('；')}`
    })
    sections.push(['## 角色当前状态', ...lines].join('\n'))
  }

  const events = input.events.filter((e) => e.chapterOrder <= input.chapterOrder)
  if (events.length) {
    const limit = input.eventLimit ?? 10
    const lines = events.slice(-limit).map((e) => {
      const meta = [e.storyTime, e.location].filter(Boolean).join(' · ')
      return `- 第${e.chapterOrder}章${meta ? ` · ${meta}` : ''}：${e.event}`
    })
    sections.push([`## 故事时间线（最近 ${lines.length} 条）`, ...lines].join('\n'))
  }

  const activeThreads = input.threads.filter((t) => t.status === 'open' || t.status === 'partial')
  if (activeThreads.length) {
    const lines = activeThreads.slice(0, 12).map((t) => {
      const meta = [
        PLOT_KIND_LABELS[t.kind],
        PLOT_STATUS_LABELS[t.status],
        t.plantedChapter != null ? `埋设${t.plantedChapter}` : '',
        t.plannedResolveChapter != null ? `计划回收${t.plannedResolveChapter}` : '',
        t.lastTouchedChapter != null ? `最近推进${t.lastTouchedChapter}` : '',
      ].filter(Boolean)
      return `- ${t.title}（${meta.join(' / ')}）`
    })
    sections.push(['## 剧情线', ...lines].join('\n'))
  }

  return sections.join('\n\n')
}

export type { TimelineEventKind }
