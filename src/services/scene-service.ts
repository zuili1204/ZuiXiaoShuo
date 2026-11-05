import type { Chapter, SceneCard, SceneCardStatus } from '@shared/types'

const api = () => window.electronAPI

function parseArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function rowToScene(row: any): SceneCard {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    novelId: row.novel_id,
    orderNum: row.order_num,
    title: row.title ?? '',
    goal: row.goal ?? '',
    obstacle: row.obstacle ?? '',
    turn: row.turn ?? '',
    outcome: row.outcome ?? '',
    emotionBefore: row.emotion_before ?? '',
    emotionAfter: row.emotion_after ?? '',
    location: row.location ?? '',
    storyTime: row.story_time ?? '',
    characters: parseArray(row.characters_json),
    props: parseArray(row.props_json),
    hooks: parseArray(row.hooks_json),
    status: (row.status ?? 'planned') as SceneCardStatus,
    wordTarget: row.word_target ?? 800,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listSceneCards(chapterId: string): Promise<SceneCard[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM scene_cards WHERE chapter_id = ? ORDER BY order_num ASC',
      [chapterId]
    )) as any[]
    return rows.map(rowToScene)
  } catch (e) {
    console.error('[scene] listSceneCards failed:', e)
    return []
  }
}

export interface CreateSceneCardInput {
  novelId: string
  chapterId: string
  orderNum?: number
  title?: string
  goal?: string
  obstacle?: string
  turn?: string
  outcome?: string
  emotionBefore?: string
  emotionAfter?: string
  location?: string
  storyTime?: string
  characters?: string[]
  props?: string[]
  hooks?: string[]
  status?: SceneCardStatus
  wordTarget?: number
}

export async function createSceneCard(input: CreateSceneCardInput): Promise<SceneCard> {
  const now = new Date().toISOString()
  let orderNum = input.orderNum
  if (orderNum == null) {
    const rows = (await api().db.query(
      'SELECT COALESCE(MAX(order_num), 0) AS max_order FROM scene_cards WHERE chapter_id = ?',
      [input.chapterId]
    )) as Array<{ max_order?: number }>
    orderNum = Number(rows[0]?.max_order ?? 0) + 1
  }
  const card: SceneCard = {
    id: crypto.randomUUID(),
    chapterId: input.chapterId,
    novelId: input.novelId,
    orderNum,
    title: input.title ?? '',
    goal: input.goal ?? '',
    obstacle: input.obstacle ?? '',
    turn: input.turn ?? '',
    outcome: input.outcome ?? '',
    emotionBefore: input.emotionBefore ?? '',
    emotionAfter: input.emotionAfter ?? '',
    location: input.location ?? '',
    storyTime: input.storyTime ?? '',
    characters: input.characters ?? [],
    props: input.props ?? [],
    hooks: input.hooks ?? [],
    status: input.status ?? 'planned',
    wordTarget: input.wordTarget ?? 800,
    createdAt: now,
    updatedAt: now,
  }
  await api().db.query(
    `INSERT INTO scene_cards (
       id, chapter_id, novel_id, order_num, title, goal, obstacle, turn, outcome,
       emotion_before, emotion_after, location, story_time,
       characters_json, props_json, hooks_json, status, word_target, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      card.id, card.chapterId, card.novelId, card.orderNum, card.title, card.goal,
      card.obstacle, card.turn, card.outcome, card.emotionBefore, card.emotionAfter,
      card.location, card.storyTime, JSON.stringify(card.characters), JSON.stringify(card.props),
      JSON.stringify(card.hooks), card.status, card.wordTarget, card.createdAt, card.updatedAt,
    ]
  )
  return card
}

export type SceneCardPatch = Partial<Omit<SceneCard, 'id' | 'chapterId' | 'novelId' | 'createdAt' | 'updatedAt'>>

export async function updateSceneCard(id: string, patch: SceneCardPatch): Promise<void> {
  const columns: string[] = []
  const values: unknown[] = []
  const set = (column: string, value: unknown) => {
    columns.push(`${column} = ?`)
    values.push(value)
  }

  if (patch.orderNum !== undefined) set('order_num', patch.orderNum)
  if (patch.title !== undefined) set('title', patch.title)
  if (patch.goal !== undefined) set('goal', patch.goal)
  if (patch.obstacle !== undefined) set('obstacle', patch.obstacle)
  if (patch.turn !== undefined) set('turn', patch.turn)
  if (patch.outcome !== undefined) set('outcome', patch.outcome)
  if (patch.emotionBefore !== undefined) set('emotion_before', patch.emotionBefore)
  if (patch.emotionAfter !== undefined) set('emotion_after', patch.emotionAfter)
  if (patch.location !== undefined) set('location', patch.location)
  if (patch.storyTime !== undefined) set('story_time', patch.storyTime)
  if (patch.characters !== undefined) set('characters_json', JSON.stringify(patch.characters))
  if (patch.props !== undefined) set('props_json', JSON.stringify(patch.props))
  if (patch.hooks !== undefined) set('hooks_json', JSON.stringify(patch.hooks))
  if (patch.status !== undefined) set('status', patch.status)
  if (patch.wordTarget !== undefined) set('word_target', patch.wordTarget)

  if (!columns.length) return
  set('updated_at', new Date().toISOString())
  values.push(id)
  await api().db.query(`UPDATE scene_cards SET ${columns.join(', ')} WHERE id = ?`, values)
}

export async function deleteSceneCard(id: string): Promise<void> {
  await api().db.query('DELETE FROM scene_cards WHERE id = ?', [id])
}

export async function reorderSceneCards(chapterId: string, orderedIds: string[]): Promise<void> {
  const now = new Date().toISOString()
  for (let i = 0; i < orderedIds.length; i++) {
    await api().db.query(
      'UPDATE scene_cards SET order_num = ?, updated_at = ? WHERE id = ? AND chapter_id = ?',
      [i + 1, now, orderedIds[i], chapterId]
    )
  }
}

export interface HooksCoverage {
  total: number
  covered: number
  uncovered: string[]
  ratio: number
}

/** 章级 hooks 被场景卡覆盖的比例；cut 状态的卡不计入覆盖。 */
export function computeHooksCoverage(cards: SceneCard[], hooks: string[]): HooksCoverage {
  const active = cards.filter((c) => c.status !== 'cut')
  const coveredHooks = hooks.filter((h) => active.some((c) => c.hooks.includes(h)))
  return {
    total: hooks.length,
    covered: coveredHooks.length,
    uncovered: hooks.filter((h) => !coveredHooks.includes(h)),
    ratio: hooks.length ? coveredHooks.length / hooks.length : 1,
  }
}

const ensuring = new Map<string, Promise<SceneCard[]>>()

/**
 * 确保某章有场景卡：已有则不重复创建（幂等）。
 * - 有 hooks：每个 hook 生成一张卡；
 * - 无 hooks：生成一张「开场」空卡，提示作者补目标。
 */
export async function ensureSceneCardsForChapter(
  novelId: string,
  chapter: Pick<Chapter, 'id' | 'hooks'> & Partial<Pick<Chapter, 'title'>>
): Promise<SceneCard[]> {
  const existing = await listSceneCards(chapter.id)
  if (existing.length) return existing

  const inflight = ensuring.get(chapter.id)
  if (inflight) return inflight

  const task = (async () => {
    const hooks = chapter.hooks ?? []
    if (hooks.length) {
      for (let i = 0; i < hooks.length; i++) {
        await createSceneCard({
          novelId,
          chapterId: chapter.id,
          orderNum: i + 1,
          title: hooks[i],
          goal: hooks[i],
          hooks: [hooks[i]],
          status: 'planned',
        })
      }
    } else {
      await createSceneCard({
        novelId,
        chapterId: chapter.id,
        orderNum: 1,
        title: '开场',
        status: 'planned',
      })
    }
    return listSceneCards(chapter.id)
  })()

  ensuring.set(chapter.id, task)
  try {
    return await task
  } finally {
    ensuring.delete(chapter.id)
  }
}
