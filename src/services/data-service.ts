import type { Novel, Volume, Chapter, Character, Foreshadowing, AgentConfig, ChatMessage, Worldview, Force, AgentRole } from '@shared/types'
import { countWords } from '@/utils/charcount'
import { normalizeText, NORMALIZE_ENABLED } from './text-normalize'
import { appendAdjustment, flushSession, recordChapterSave, type SessionSource } from './session-service'
import { clearStoryStateForChapter, clearStoryStateForCharacter, clearStoryStateForNovel } from './story-state-service'

const api = () => window.electronAPI

// 将数据库中存储的 genre（可能为空、纯字符串、JSON 字符串数组或已被错误保存的单字符串）归一化为 string[]
function parseGenre(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  const s = raw.trim()
  try {
    const parsed = JSON.parse(s)
    // JSON.parse('"玄幻"') 返回的是字符串，需包装为数组；['a','b'] 直接返回
    return Array.isArray(parsed) ? parsed : [parsed as string]
  } catch {
    // 非 JSON 内容，按逗号/分号分隔
    return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)
  }
}

// ===== Novel Operations =====

// 通过 volumeId 反查 novelId（供 chapter/volume 删除时联动知识库）
async function resolveNovelIdByVolume(volumeId: string): Promise<string | undefined> {
  try {
    const rows = (await api().db.query('SELECT novel_id FROM volumes WHERE id = ?', [volumeId])) as any[]
    return rows[0]?.novel_id
  } catch {
    return undefined
  }
}

export const novelService = {
  async getAll(): Promise<Novel[]> {
    try {
      const novels = await api().db.query('SELECT * FROM novels ORDER BY updated_at DESC') as any[]
      return novels.map((n) => ({
        ...n,
        genre: parseGenre(n.genre),
        masterOutline: n.master_outline ?? '',
        seriesName: n.series_name ?? '',
        seriesOrder: Number(n.series_order) || 0,
      }))
    } catch (e) {
      console.error('Failed to load novels:', e)
      return []
    }
  },

  async getById(id: string): Promise<Novel | null> {
    try {
      const results = await api().db.query('SELECT * FROM novels WHERE id = ?', [id]) as any[]
      if (results.length === 0) return null
      const n = results[0]
      return {
        ...n,
        genre: parseGenre(n.genre),
        masterOutline: n.master_outline ?? '',
        seriesName: n.series_name ?? '',
        seriesOrder: Number(n.series_order) || 0,
      }
    } catch (e) {
      console.error('Failed to load novel:', e)
      return null
    }
  },

  async create(novel: Novel): Promise<void> {
    await api().db.query(
      `INSERT INTO novels (id, title, description, cover_path, genre, target_platform, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [novel.id, novel.title, novel.description, novel.coverPath || null,
       JSON.stringify(novel.genre), novel.targetPlatform, novel.status,
       novel.createdAt, novel.updatedAt]
    )
    // 初始化知识库骨架
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.initKnowledgeBase(novel.id, novel)
    } catch (e) {
      console.warn('[novelService.create] init knowledge base failed:', e)
    }
  },

  async update(id: string, data: Partial<Novel>): Promise<void> {
    // camelCase → snake_case 映射，并跳过非列字段（id / createdAt）
    const columnMap: Record<string, string> = {
      title: 'title',
      description: 'description',
      coverPath: 'cover_path',
      genre: 'genre',
      targetPlatform: 'target_platform',
      status: 'status',
      masterOutline: 'master_outline',
      seriesName: 'series_name',
      seriesOrder: 'series_order',
    }
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      const col = columnMap[key]
      if (!col) continue // 忽略 id / createdAt 等不存在的列
      if (col === 'genre') {
        fields.push('genre = ?')
        values.push(JSON.stringify(value))
      } else {
        fields.push(`${col} = ?`)
        values.push(value)
      }
    }
    if (fields.length === 0) return // 无可更新字段
    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)

    await api().db.query(
      `UPDATE novels SET ${fields.join(', ')} WHERE id = ?`,
      values
    )
  },

  async delete(id: string): Promise<void> {
    // 级联清理：卷 → 章节（含正文文件）→ 角色 → 伏笔 → 聊天记录
    const volumes = (await api().db.query(
      'SELECT id FROM volumes WHERE novel_id = ?', [id]
    )) as { id: string }[]
    for (const vol of volumes) {
      const chapters = (await api().db.query(
        'SELECT content_path FROM chapters WHERE volume_id = ?', [vol.id]
      )) as { content_path: string }[]
      for (const ch of chapters) {
        if (ch.content_path) {
          try { await api().file.delete(ch.content_path) } catch { /* ignore */ }
        }
      }
      await api().db.query('DELETE FROM chapters WHERE volume_id = ?', [vol.id])
    }
    await api().db.query('DELETE FROM volumes WHERE novel_id = ?', [id])
    await api().db.query('DELETE FROM characters WHERE novel_id = ?', [id])
    await api().db.query('DELETE FROM forces WHERE novel_id = ?', [id])
    await api().db.query('DELETE FROM foreshadowings WHERE novel_id = ?', [id])
    await api().db.query('DELETE FROM chat_messages WHERE novel_id = ?', [id])
    try { await clearStoryStateForNovel(id) } catch { /* 新表未迁移时忽略 */ }
    await api().db.query('DELETE FROM novels WHERE id = ?', [id])
    // 清理内容磁盘上的追踪/rag 索引文件
    try { await api().file.delete(`content/tracking/${id}.json`) } catch { /* ignore */ }
    try { await api().file.delete(`content/rag/${id}.json`) } catch { /* ignore */ }
    // 清理快照与章节正文目录（此前删书后仍残留 content/snapshots/<id> 与空章节目录）
    try { await api().file.deleteDir(`content/snapshots/${id}`) } catch { /* ignore */ }
    try { await api().file.deleteDir(`content/${id}`) } catch { /* ignore */ }
    // 清理知识库目录
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.deleteAll(id)
      await api().file.deleteDir(`content/knowledge/${id}`)
    } catch (e) {
      console.warn('[novelService.delete] delete knowledge base failed:', e)
    }
  },
}

// ===== Volume Operations =====
export const volumeService = {
  async getByNovelId(novelId: string): Promise<Volume[]> {
    try {
      const rows = await api().db.query(
        'SELECT * FROM volumes WHERE novel_id = ? ORDER BY order_num ASC', [novelId]
      ) as any[]
      return rows.map(rowToVolume)
    } catch (e) {
      console.error('Failed to load volumes:', e)
      return []
    }
  },

  async create(volume: Volume): Promise<void> {
    await api().db.query(
      `INSERT INTO volumes (id, novel_id, title, order_num, summary, goal, climax, ending_hook, estimated_chapters, target_word_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        volume.id,
        volume.novelId,
        volume.title,
        volume.order,
        volume.summary,
        volume.goal ?? '',
        volume.climax ?? '',
        volume.endingHook ?? '',
        volume.estimatedChapters ?? 0,
        volume.targetWordCount ?? 0,
        new Date().toISOString(),
      ]
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncOutline(volume.novelId)
    } catch (e) {
      console.warn('[volumeService.create] kb sync failed:', e)
    }
  },

  async updateOrder(volumeId: string, newOrder: number): Promise<void> {
    await api().db.query('UPDATE volumes SET order_num = ? WHERE id = ?', [newOrder, volumeId])
  },

  async delete(id: string): Promise<void> {
    // 卷删除后无法再反查 novel_id，先取出来供快照清理与知识库联动使用
    const novelId = await resolveNovelIdByVolume(id)
    // 级联删除卷下所有章节、正文文件与章节快照
    const chapters = (await api().db.query(
      'SELECT id, content_path, word_count FROM chapters WHERE volume_id = ?', [id]
    )) as { id: string; content_path: string; word_count: number }[]
    for (const ch of chapters) {
      if (ch.content_path) {
        try { await api().file.delete(ch.content_path) } catch { /* ignore */ }
      }
      if (novelId) {
        try { await api().file.deleteDir(`content/snapshots/${novelId}/${ch.id}`) } catch { /* ignore */ }
        try { await clearStoryStateForChapter(novelId, ch.id) } catch { /* 新表未迁移时忽略 */ }
      }
    }
    await api().db.query('DELETE FROM chapters WHERE volume_id = ?', [id])
    await api().db.query('DELETE FROM volumes WHERE id = ?', [id])
    // 日更统计：删除的正文同样计入净增（先落盘未结算会话，避免与删除修正重复）
    const removedWords = chapters.reduce((sum, ch) => sum + (Number(ch.word_count) || 0), 0)
    if (novelId && removedWords > 0) {
      try {
        await flushSession(novelId)
        await appendAdjustment(novelId, -removedWords)
      } catch { /* 统计失败不阻断删除 */ }
    }
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      if (novelId) await knowledgeService.onVolumeDeleted(novelId, id)
    } catch (e) {
      console.warn('[volumeService.delete] kb sync failed:', e)
    }
  },

  async update(id: string, data: Partial<Volume>): Promise<void> {
    const fields: string[] = []
    const values: unknown[] = []
    if (data.title !== undefined) {
      fields.push('title = ?')
      values.push(data.title)
    }
    if (data.summary !== undefined) {
      fields.push('summary = ?')
      values.push(data.summary)
    }
    if (data.order !== undefined) {
      fields.push('order_num = ?')
      values.push(data.order)
    }
    if (data.goal !== undefined) {
      fields.push('goal = ?')
      values.push(data.goal)
    }
    if (data.climax !== undefined) {
      fields.push('climax = ?')
      values.push(data.climax)
    }
    if (data.endingHook !== undefined) {
      fields.push('ending_hook = ?')
      values.push(data.endingHook)
    }
    if (data.estimatedChapters !== undefined) {
      fields.push('estimated_chapters = ?')
      values.push(data.estimatedChapters)
    }
    if (data.targetWordCount !== undefined) {
      fields.push('target_word_count = ?')
      values.push(data.targetWordCount)
    }
    if (fields.length === 0) return
    values.push(id)
    await api().db.query(
      `UPDATE volumes SET ${fields.join(', ')} WHERE id = ?`,
      values
    )
  },
}

// 将数据库行（snake_case）映射为 Volume（camelCase）。
// 修复：SELECT * 返回 order_num，Volume 声明的是 order——之前 syncOutline
// 直接读 v.order 恒为 undefined，知识库 outline.md 被写成「第undefined卷」。
function rowToVolume(row: any): Volume {
  return {
    id: row.id,
    novelId: row.novel_id,
    title: row.title,
    order: row.order_num,
    summary: row.summary,
    goal: row.goal || undefined,
    climax: row.climax || undefined,
    endingHook: row.ending_hook || undefined,
    estimatedChapters: Number(row.estimated_chapters) || undefined,
    targetWordCount: Number(row.target_word_count) || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// 将数据库行（snake_case）映射为 Chapter（camelCase）
function rowToChapter(row: any): Chapter {
  return {
    id: row.id,
    volumeId: row.volume_id,
    title: row.title,
    order: row.order_num,
    contentPath: row.content_path,
    wordCount: row.word_count,
    status: row.status,
    targetWordCount: row.target_word_count,
    hooks: typeof row.hooks === 'string'
      ? JSON.parse(row.hooks || '[]')
      : (row.hooks ?? []),
    summary: row.summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ===== Chapter Operations =====
export const chapterService = {
  async getById(id: string): Promise<Chapter | null> {
    try {
      const rows = await api().db.query('SELECT * FROM chapters WHERE id = ?', [id]) as any[]
      return rows[0] ? rowToChapter(rows[0]) : null
    } catch (e) {
      console.error('Failed to get chapter by id:', e)
      return null
    }
  },

  async getByVolumeId(volumeId: string): Promise<Chapter[]> {
    try {
      const chapters = await api().db.query(
        'SELECT * FROM chapters WHERE volume_id = ? ORDER BY order_num ASC', [volumeId]
      ) as any[]
      return chapters.map(rowToChapter)
    } catch (e) {
      console.error('Failed to load chapters:', e)
      return []
    }
  },

  async create(chapter: Chapter): Promise<void> {
    // Create markdown file
    await api().file.write(chapter.contentPath, '')
    // Save metadata
    await api().db.query(
      `INSERT INTO chapters (id, volume_id, title, order_num, content_path, word_count, target_word_count, status, hooks, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [chapter.id, chapter.volumeId, chapter.title, chapter.order,
       chapter.contentPath, chapter.wordCount, chapter.targetWordCount,
       chapter.status, JSON.stringify(chapter.hooks), chapter.summary ?? '',
       chapter.createdAt, chapter.updatedAt]
    )
    // 知识库联动：刷新大纲
    try {
      const { knowledgeService } = await import('./knowledge-service')
      const novelId = await resolveNovelIdByVolume(chapter.volumeId)
      if (novelId) await knowledgeService.syncOutline(novelId)
    } catch (e) {
      console.warn('[chapterService.create] kb sync failed:', e)
    }
  },

  async saveContent(
    chapterId: string,
    content: string,
    opts?: { source?: SessionSource; novelId?: string }
  ): Promise<void> {
    const chapter = await chapterService.getById(chapterId)
    if (!chapter) throw new Error('Chapter not found')

    // IMP-04：标点统一。这里是唯一咽喉位——
    // UI 自动保存 / 手动保存 / rewrite_chapter / commit_tracking 带正文 全部经过此函数。
    const normalized = NORMALIZE_ENABLED
      ? normalizeText(content)
      : { text: content, changes: 0, details: { cornerQuotes: 0, straightQuotes: 0, cnEnSpaces: 0, typoFixes: 0 } }
    if (normalized.changes > 0) {
      console.info('[text-normalize] 标点统一改动', normalized.changes, normalized.details)
    }

    const beforeWords = Number(chapter.wordCount) || 0
    await api().file.write(chapter.contentPath, normalized.text)
    const wordCount = countWords(normalized.text)
    await api().db.query(
      'UPDATE chapters SET word_count = ?, updated_at = ? WHERE id = ?',
      [wordCount, new Date().toISOString(), chapterId]
    )

    // 日更统计：只有明确标注来源的写入才计入（导入、快照恢复等不算“今天写的”）
    if (opts?.source) {
      const novelId = opts.novelId ?? await resolveNovelIdByVolume(chapter.volumeId)
      if (novelId) {
        await recordChapterSave(novelId, chapterId, beforeWords, wordCount, { source: opts.source })
      }
    }
  },

  async loadContent(chapterId: string): Promise<string> {
    const chapter = await chapterService.getById(chapterId)
    if (!chapter) return ''
    try {
      return await api().file.read(chapter.contentPath)
    } catch {
      return ''
    }
  },

  async delete(id: string): Promise<void> {
    const chapter = await chapterService.getById(id)
    const novelId = chapter ? await resolveNovelIdByVolume(chapter.volumeId) : undefined
    if (chapter?.contentPath) {
      try { await api().file.delete(chapter.contentPath) } catch { /* ignore */ }
    }
    // 章节删除后其快照目录失去归属，一并清理
    if (novelId) {
      try { await api().file.deleteDir(`content/snapshots/${novelId}/${id}`) } catch { /* ignore */ }
      try { await clearStoryStateForChapter(novelId, id) } catch { /* 新表未迁移时忽略 */ }
    }
    await api().db.query('DELETE FROM chapters WHERE id = ?', [id])
    // 日更统计：删除的正文计入当日净增（先落盘未结算会话，避免重复扣减）
    if (chapter && novelId) {
      const removed = Number(chapter.wordCount) || 0
      if (removed > 0) {
        try {
          await flushSession(novelId)
          await appendAdjustment(novelId, -removed, { chapterId: id })
        } catch { /* 统计失败不阻断删除 */ }
      }
    }
    // 知识库联动：删除章节 KB 文件
    if (chapter) {
      try {
        const { knowledgeService } = await import('./knowledge-service')
        if (novelId) await knowledgeService.onChapterDeleted(novelId, id)
      } catch (e) {
        console.warn('[chapterService.delete] kb sync failed:', e)
      }
    }
  },

  async updateStatus(chapterId: string, status: string): Promise<void> {
    await api().db.query(
      'UPDATE chapters SET status = ?, updated_at = ? WHERE id = ?',
      [status, new Date().toISOString(), chapterId]
    )
  },

  async setVolume(chapterId: string, volumeId: string): Promise<void> {
    await api().db.query(
      'UPDATE chapters SET volume_id = ?, updated_at = ? WHERE id = ?',
      [volumeId, new Date().toISOString(), chapterId]
    )
  },

  async update(id: string, data: Partial<Chapter>): Promise<void> {
    const fields: string[] = []
    const values: unknown[] = []
    if (data.title !== undefined) {
      fields.push('title = ?')
      values.push(data.title)
    }
    if (data.targetWordCount !== undefined) {
      fields.push('target_word_count = ?')
      values.push(data.targetWordCount)
    }
    if (data.order !== undefined) {
      fields.push('order_num = ?')
      values.push(data.order)
    }
    if (data.status !== undefined) {
      fields.push('status = ?')
      values.push(data.status)
    }
    if (data.summary !== undefined) {
      fields.push('summary = ?')
      values.push(data.summary)
    }
    if (data.hooks !== undefined) {
      fields.push('hooks = ?')
      values.push(JSON.stringify(data.hooks))
    }
    if (fields.length === 0) return
    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)
    await api().db.query(
      `UPDATE chapters SET ${fields.join(', ')} WHERE id = ?`,
      values
    )
  },
}

// ===== Character Operations =====
export const characterService = {
  async getByNovelId(novelId: string): Promise<Character[]> {
    try {
      return await api().db.query(
        'SELECT * FROM characters WHERE novel_id = ?', [novelId]
      ) as Character[]
    } catch (e) {
      console.error('Failed to load characters:', e)
      return []
    }
  },

  async create(character: Character): Promise<void> {
    await api().db.query(
      `INSERT INTO characters (id, novel_id, name, role, gender, age, personality, appearance, profile, dynamic_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [character.id, character.novelId, character.name, character.role,
       character.gender || 'unknown', character.age || '', character.personality || '',
       character.appearance || '', character.profile, character.dynamicState,
       new Date().toISOString(), new Date().toISOString()]
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncCharacters(character.novelId)
    } catch (e) {
      console.warn('[characterService.create] kb sync failed:', e)
    }
  },

  async update(id: string, data: Partial<Character>): Promise<void> {
    // camelCase → snake_case 映射，并跳过非列字段（id / novelId）
    const columnMap: Record<string, string> = {
      name: 'name',
      role: 'role',
      gender: 'gender',
      age: 'age',
      personality: 'personality',
      appearance: 'appearance',
      profile: 'profile',
      dynamicState: 'dynamic_state',
    }
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      const col = columnMap[key]
      if (!col) continue // 忽略 id / novelId 等不存在的列
      fields.push(`${col} = ?`)
      values.push(value)
    }
    if (fields.length === 0) return // 无可更新字段
    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(id)
    await api().db.query(
      `UPDATE characters SET ${fields.join(', ')} WHERE id = ?`,
      values
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      const rows = (await api().db.query('SELECT novel_id FROM characters WHERE id = ?', [id])) as any[]
      if (rows[0]?.novel_id) await knowledgeService.syncCharacters(rows[0].novel_id)
    } catch (e) {
      console.warn('[characterService.update] kb sync failed:', e)
    }
  },

  async delete(id: string): Promise<void> {
    const rows = (await api().db.query('SELECT novel_id FROM characters WHERE id = ?', [id])) as any[]
    const novelId = rows[0]?.novel_id
    await api().db.query('DELETE FROM characters WHERE id = ?', [id])
    if (novelId) {
      try { await clearStoryStateForCharacter(novelId, id) } catch { /* 新表未迁移时忽略 */ }
    }
    // 知识库联动
    if (novelId) {
      try {
        const { knowledgeService } = await import('./knowledge-service')
        await knowledgeService.onCharacterDeleted(novelId, id)
      } catch (e) {
        console.warn('[characterService.delete] kb sync failed:', e)
      }
    }
  },
}

// ===== 世界观服务（文档 G6 / M6） =====
export const worldviewService = {
  async getAll(): Promise<Worldview[]> {
    return api().db.query('SELECT * FROM worldviews ORDER BY updated_at DESC') as Promise<Worldview[]>
  },
  async getByNovelId(novelId: string): Promise<Worldview[]> {
    return api().db.query(
      'SELECT * FROM worldviews WHERE novel_id = ? ORDER BY updated_at DESC',
      [novelId],
    ) as Promise<Worldview[]>
  },
  async getById(id: string): Promise<Worldview | null> {
    const rows = (await api().db.query('SELECT * FROM worldviews WHERE id = ?', [id])) as Worldview[]
    return rows[0] ?? null
  },
  async create(data: Partial<Worldview>): Promise<Worldview> {
    const now = new Date().toISOString()
    const row: Worldview = {
      id: data.id ?? `wv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      novelId: data.novelId!,
      category: data.category ?? 'other',
      title: data.title ?? '未命名设定',
      content: data.content ?? '',
      createdAt: now,
      updatedAt: now,
    }
    await api().db.query(
      `INSERT INTO worldviews (id, novel_id, category, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.novelId, row.category, row.title, row.content, row.createdAt, row.updatedAt],
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncWorldviews(row.novelId)
    } catch (e) {
      console.warn('[worldviewService.create] kb sync failed:', e)
    }
    return row
  },
  async update(id: string, data: Partial<Worldview>): Promise<Worldview> {
    const existing = await this.getById(id)
    if (!existing) throw new Error(`世界观不存在: ${id}`)
    const updated: Worldview = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    }
    await api().db.query(
      `UPDATE worldviews SET category = ?, title = ?, content = ?, updated_at = ? WHERE id = ?`,
      [updated.category, updated.title, updated.content, updated.updatedAt, id],
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncWorldviews(existing.novelId)
    } catch (e) {
      console.warn('[worldviewService.update] kb sync failed:', e)
    }
    return updated
  },
  async delete(id: string): Promise<void> {
    const rows = (await api().db.query('SELECT novel_id FROM worldviews WHERE id = ?', [id])) as any[]
    const novelId = rows[0]?.novel_id
    await api().db.query('DELETE FROM worldviews WHERE id = ?', [id])
    // 知识库联动
    if (novelId) {
      try {
        const { knowledgeService } = await import('./knowledge-service')
        await knowledgeService.onWorldviewDeleted(novelId, id)
      } catch (e) {
        console.warn('[worldviewService.delete] kb sync failed:', e)
      }
    }
  },
}

// ===== 势力服务（Force） =====
// db.query 返回 snake_case 字段，需手动映射为 camelCase
function rowToForce(row: any): Force {
  return {
    id: row.id,
    novelId: row.novel_id,
    name: row.name,
    type: (row.type ?? 'other') as Force['type'],
    level: row.level ?? '',
    description: row.description ?? '',
    protagonistRelation: row.protagonist_relation ?? '',
    coreMembers: row.core_members ?? '',
    territory: row.territory ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const forceService = {
  async getByNovelId(novelId: string): Promise<Force[]> {
    try {
      const rows = (await api().db.query(
        'SELECT * FROM forces WHERE novel_id = ? ORDER BY updated_at DESC',
        [novelId],
      )) as any[]
      return rows.map(rowToForce)
    } catch (e) {
      console.error('Failed to load forces:', e)
      return []
    }
  },
  async getById(id: string): Promise<Force | null> {
    const rows = (await api().db.query('SELECT * FROM forces WHERE id = ?', [id])) as any[]
    return rows[0] ? rowToForce(rows[0]) : null
  },
  async create(data: Partial<Force>): Promise<Force> {
    const now = new Date().toISOString()
    const row: Force = {
      id: data.id ?? `force_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      novelId: data.novelId!,
      name: data.name ?? '未命名势力',
      type: data.type ?? 'other',
      level: data.level ?? '',
      description: data.description ?? '',
      protagonistRelation: data.protagonistRelation ?? '',
      coreMembers: data.coreMembers ?? '',
      territory: data.territory ?? '',
      createdAt: now,
      updatedAt: now,
    }
    await api().db.query(
      `INSERT INTO forces (id, novel_id, name, type, level, description, protagonist_relation, core_members, territory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.novelId, row.name, row.type, row.level, row.description,
       row.protagonistRelation, row.coreMembers, row.territory, row.createdAt, row.updatedAt],
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncForces(row.novelId)
    } catch (e) {
      console.warn('[forceService.create] kb sync failed:', e)
    }
    return row
  },
  async update(id: string, data: Partial<Force>): Promise<Force> {
    const existing = await this.getById(id)
    if (!existing) throw new Error(`势力不存在: ${id}`)
    const updated: Force = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    }
    await api().db.query(
      `UPDATE forces SET name = ?, type = ?, level = ?, description = ?, protagonist_relation = ?, core_members = ?, territory = ?, updated_at = ? WHERE id = ?`,
      [updated.name, updated.type, updated.level, updated.description,
       updated.protagonistRelation, updated.coreMembers, updated.territory, updated.updatedAt, id],
    )
    // 知识库联动
    try {
      const { knowledgeService } = await import('./knowledge-service')
      await knowledgeService.syncForces(existing.novelId)
    } catch (e) {
      console.warn('[forceService.update] kb sync failed:', e)
    }
    return updated
  },
  async delete(id: string): Promise<void> {
    const rows = (await api().db.query('SELECT novel_id FROM forces WHERE id = ?', [id])) as any[]
    const novelId = rows[0]?.novel_id
    await api().db.query('DELETE FROM forces WHERE id = ?', [id])
    // 知识库联动
    if (novelId) {
      try {
        const { knowledgeService } = await import('./knowledge-service')
        await knowledgeService.onForceDeleted(novelId, id)
      } catch (e) {
        console.warn('[forceService.delete] kb sync failed:', e)
      }
    }
  },
}

// ===== Agent Config Operations =====
export const agentConfigService = {
  async getAll(): Promise<AgentConfig[]> {
    try {
      const rows = await api().db.query('SELECT * FROM agent_configs WHERE is_active = 1') as Record<string, unknown>[]
      return rows
        .filter((c) => c.id)
        .map((c) => ({
          id: c.id as string,
          name: c.name as string,
          role: c.role as AgentRole,
          provider: c.provider as string,
          model: c.model as string,
          temperature: c.temperature as number,
          maxTokens: c.max_tokens as number,
          // IMP-08：top_p 持久化；空值保持 undefined（请求体不附加，走模型默认）
          topP: c.top_p == null ? undefined : Number(c.top_p),
          apiKeyEncrypted: (c.api_key_encrypted || '') as string,
          systemPrompt: c.system_prompt as string,
          skillRefs: JSON.parse((c.skill_refs || '[]') as string),
          isActive: !!c.is_active,
          createdAt: c.created_at as string,
        }))
    } catch (e) {
      console.error('Failed to load agent configs:', e)
      return []
    }
  },

  async save(config: AgentConfig): Promise<void> {
    const id = config.id || `agent-${config.role}-${Date.now()}`
    await api().db.query(
      `INSERT OR REPLACE INTO agent_configs (id, name, role, provider, model, temperature, max_tokens, top_p, api_key_encrypted, system_prompt, skill_refs, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, config.name, config.role, config.provider, config.model,
       config.temperature, config.maxTokens,
       config.topP == null ? null : config.topP,
       config.apiKeyEncrypted || '',
       config.systemPrompt, JSON.stringify(config.skillRefs), new Date().toISOString()]
    )
  },

  async delete(id: string): Promise<void> {
    await api().db.query('UPDATE agent_configs SET is_active = 0 WHERE id = ?', [id])
  },
}

// ===== Chat Message Operations =====
export const chatService = {
  async getByNovelId(novelId: string, limit = 50): Promise<ChatMessage[]> {
    try {
      return await api().db.query(
        'SELECT * FROM chat_messages WHERE novel_id = ? ORDER BY created_at DESC LIMIT ?',
        [novelId, limit]
      ) as ChatMessage[]
    } catch (e) {
      console.error('Failed to load chat messages:', e)
      return []
    }
  },

  async save(message: ChatMessage): Promise<void> {
    await api().db.query(
      `INSERT INTO chat_messages (id, novel_id, chapter_id, agent_id, role, content, tokens_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.id, message.novelId, message.chapterId || null, message.agentId || null,
       message.role, message.content, message.tokensUsed, message.createdAt]
    )
  },

  async deleteByNovelAndAgent(novelId: string, agentId: string): Promise<void> {
    await api().db.query(
      'DELETE FROM chat_messages WHERE novel_id = ? AND agent_id = ?',
      [novelId, agentId]
    )
  },
}

// ===== Foreshadowing Operations =====
export const foreshadowingService = {
  async getByNovelId(novelId: string): Promise<Foreshadowing[]> {
    try {
      // SQLite 返回 snake_case 原始行，必须显式映射为 camelCase，
      // 否则 plantedChapter 等字段全部 undefined（真机验证发现的缺陷）
      const rows = (await api().db.query(
        'SELECT * FROM foreshadowings WHERE novel_id = ? ORDER BY planted_chapter ASC',
        [novelId]
      )) as any[]
      return rows.map((r) => ({
        id: r.id,
        novelId: r.novel_id,
        content: r.content,
        plantedChapter: r.planted_chapter ?? 0,
        plannedResolveChapter: r.planned_resolve_chapter ?? undefined,
        resolvedChapter: r.resolved_chapter ?? undefined,
        status: r.status,
        importance: r.importance,
      }))
    } catch (e) {
      console.error('Failed to load foreshadowings:', e)
      return []
    }
  },

  async create(f: Foreshadowing): Promise<void> {
    await api().db.query(
      `INSERT INTO foreshadowings (id, novel_id, content, planted_chapter, planned_resolve_chapter, resolved_chapter, status, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.novelId, f.content, f.plantedChapter, f.plannedResolveChapter || null,
       f.resolvedChapter || null, f.status, f.importance, new Date().toISOString()]
    )
  },

  async updateStatus(id: string, status: string, resolvedChapter?: number): Promise<void> {
    await api().db.query(
      'UPDATE foreshadowings SET status = ?, resolved_chapter = ? WHERE id = ?',
      [status, resolvedChapter || null, id]
    )
  },
}

// ===== 全文搜索（跨章节正文） =====
export interface SearchHit {
  chapterId: string
  volumeId: string
  chapterTitle: string
  volumeTitle: string
  snippet: string   // 命中上下文片段
  line: number      // 命中行号（从 1 计）
}

export interface SearchResult {
  hits: SearchHit[]
  /** 命中总行数（未截断）。total > hits.length 时 UI 应提示结果被截断 */
  total: number
}

export async function searchChapters(
  novelId: string,
  query: string,
  topK = 30
): Promise<SearchResult> {
  const q = query.trim().toLowerCase()
  if (!q) return { hits: [], total: 0 }
  const hits: SearchHit[] = []
  const volumes = (await volumeService.getByNovelId(novelId)) as Volume[]
  for (const vol of volumes) {
    const chapters = (await chapterService.getByVolumeId(vol.id)) as Chapter[]
    for (const ch of chapters) {
      if (!ch.contentPath) continue
      let content = ''
      try {
        content = await api().file.read(ch.contentPath)
      } catch {
        continue
      }
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        if (line.toLowerCase().includes(q)) {
          const start = Math.max(0, idx - 1)
          const end = Math.min(lines.length, idx + 2)
          hits.push({
            chapterId: ch.id,
            volumeId: vol.id,
            chapterTitle: ch.title,
            volumeTitle: vol.title,
            snippet: lines.slice(start, end).join('\n').trim().slice(0, 200),
            line: idx + 1,
          })
        }
      })
    }
  }
  return { hits: hits.slice(0, topK), total: hits.length }
}

/**
 * IMP-03：章节完整性自检——找出「数据库显示有内容，但磁盘 md 缺失或为空」的章节。
 *
 * 历史成因：① commitChapterAndSave 只更新数据库不写 md（已修）；
 * ② 写作产出只留在聊天窗口、从未写入章节文件。
 * fileChars = -1 表示文件不存在或不可读。
 *
 * 返回结构供 UI 做启动体检与数据修复入口。
 */
export interface ChapterIntegrityIssue {
  chapterId: string
  title: string
  order: number
  dbWordCount: number
  fileChars: number
  status: string
  kind: 'missing' | 'mismatch'
}

export async function verifyChapterIntegrity(
  novelId: string
): Promise<ChapterIntegrityIssue[]> {
  const volumes = await volumeService.getByNovelId(novelId)
  const broken: ChapterIntegrityIssue[] = []

  for (const v of volumes) {
    const chs = await chapterService.getByVolumeId(v.id)
    for (const c of chs) {
      let fileChars = -1
      try {
        const text = await api().file.read(c.contentPath)
        fileChars = (text || '').replace(/\s/g, '').length
      } catch {
        fileChars = -1
      }
      const dbCount = c.wordCount || 0
      if (fileChars <= 0 && dbCount > 0) {
        broken.push({
          chapterId: c.id,
          title: c.title,
          order: c.order,
          dbWordCount: dbCount,
          fileChars,
          status: c.status,
          kind: 'missing',
        })
      } else if (fileChars > 0 && dbCount !== fileChars) {
        broken.push({
          chapterId: c.id,
          title: c.title,
          order: c.order,
          dbWordCount: dbCount,
          fileChars,
          status: c.status,
          kind: 'mismatch',
        })
      }
    }
  }
  return broken
}

/** 以磁盘正文为准回填字数（正文存在且非空时）。 */
export async function repairChapterWordCount(
  chapterId: string
): Promise<{ ok: boolean; wordCount?: number; error?: string }> {
  try {
    const chapter = await chapterService.getById(chapterId)
    if (!chapter) return { ok: false, error: '章节不存在' }
    const text = await api().file.read(chapter.contentPath)
    const wordCount = countWords(text || '')
    if (wordCount <= 0) return { ok: false, error: '正文文件为空，无法回填' }
    await api().db.query(
      'UPDATE chapters SET word_count = ?, updated_at = ? WHERE id = ?',
      [wordCount, new Date().toISOString(), chapterId]
    )
    return { ok: true, wordCount }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || '回填失败' }
  }
}

/** 标记章节正文缺失：清零字数并退回草稿，避免继续以「已完成」状态参与统计。 */
export async function markChapterMissing(chapterId: string): Promise<void> {
  await api().db.query(
    "UPDATE chapters SET word_count = 0, status = 'draft', updated_at = ? WHERE id = ?",
    [new Date().toISOString(), chapterId]
  )
}
