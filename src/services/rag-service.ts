// RAG (Retrieval-Augmented Generation) Service
// In-memory implementation; will be extended with LanceDB/ChromaDB support

import type { Chapter, Worldview, Character, Foreshadowing, Force } from '@shared/types'
import { worldviewService, characterService, foreshadowingService, chapterService, volumeService, forceService } from './data-service'

interface DocumentChunk {
  id: string
  text: string
  type: 'chapter' | 'setting' | 'character' | 'worldview' | 'foreshadowing' | 'force'
  sourceId: string
  sourceTitle: string
  novelId: string
  chapterOrder?: number
}

interface SearchResult {
  content: string
  source: string
  sourceId: string
  type: string
  score: number
  chapterOrder?: number
}

// In-memory chunk store
const chunkStore: Map<string, DocumentChunk[]> = new Map()
// 脏标记，避免无谓写盘
const dirtyMap: Map<string, boolean> = new Map()

function ragPath(novelId: string): string {
  return `content/rag/${novelId}.json`
}

// 从磁盘加载已索引分块
export async function loadIndex(novelId: string): Promise<void> {
  const fallback = () => chunkStore.set(novelId, [])
  try {
    const exists = await window.electronAPI.file.exists(ragPath(novelId))
    if (!exists) {
      fallback()
      return
    }
    const raw = await window.electronAPI.file.read(ragPath(novelId))
    // 文件存在但为空（被截断/未写完）时，直接重置为空索引，避免 JSON.parse 报错
    if (!raw || !raw.trim()) {
      fallback()
      return
    }
    try {
      const parsed = JSON.parse(raw) as DocumentChunk[]
      chunkStore.set(novelId, Array.isArray(parsed) ? parsed : [])
    } catch (e) {
      console.warn(`RAG index for ${novelId} is corrupt, resetting to empty.`, e)
      fallback()
    }
  } catch (e) {
    console.error('Failed to load RAG index:', e)
    fallback()
  }
}

// 每个 novel 的持久化串行队列：避免并发 persist 同时对同一目标文件 rename 触发 Windows EPERM
const persistQueues: Map<string, Promise<void>> = new Map()

// 落盘当前分块（原子写：先写临时文件，校验通过后再 rename 覆盖，避免中断留下半截文件）
async function persist(novelId: string): Promise<void> {
  const prev = persistQueues.get(novelId) || Promise.resolve()
  const run = prev
    .catch(() => {})
    .then(() => doPersist(novelId))
  persistQueues.set(novelId, run)
  return run
}

async function doPersist(novelId: string): Promise<void> {
  try {
    const chunks = chunkStore.get(novelId) || []
    const finalPath = ragPath(novelId)
    // 随机临时名，避免并发 persist 共用同一 .tmp 互相覆盖/抢夺导致 rename ENOENT
    const tmpPath = `${finalPath}.${crypto.randomUUID()}.tmp`
    const serialized = JSON.stringify(chunks, null, 2)
    await window.electronAPI.file.write(tmpPath, serialized)
    // 读回校验，确认临时文件确实是合法 JSON 后再覆盖
    const verify = await window.electronAPI.file.read(tmpPath)
    JSON.parse(verify)
    await window.electronAPI.file.rename(tmpPath, finalPath)
    dirtyMap.set(novelId, false)
  } catch (e) {
    console.error('Failed to persist RAG index:', e)
  }
}

function markDirty(novelId: string) {
  dirtyMap.set(novelId, true)
}

/**
 * 中文友好的分词：拉丁词 + 汉字 unigram + 汉字 bigram。
 * 中文没有空格，旧实现把整句当成一个 token 导致检索完全失效（文档 G3）。
 * 引入 bigram 后，任意 2 字连续片段都能命中，召回大幅提升。
 */
function simpleTokenize(text: string): string[] {
  const lower = (text || '').toLowerCase()
  const latin = lower.match(/[a-z0-9]+/g) || []
  const cjkSegs = lower.match(/[一-鿿]+/g) || []
  const bigrams: string[] = []
  for (const seg of cjkSegs) {
    for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2))
  }
  return [...latin, ...bigrams]
}

// Simple TF-IDF-like keyword search（标题加权）
function keywordSearch(query: string, chunks: DocumentChunk[], topK: number): SearchResult[] {
  const queryTokens = simpleTokenize(query)
  if (queryTokens.length === 0) return []

  return chunks
    .map((chunk) => {
      const textTokens = simpleTokenize(chunk.text)
      // 标题 / 来源：权重更高，提升精确设定/角色的召回
      const titleTokens = simpleTokenize(chunk.sourceTitle)
      const titleSet = new Set(titleTokens)
      const textSet = new Set(textTokens)

      let score = 0
      for (const qt of queryTokens) {
        if (titleSet.has(qt)) score += 3
        if (textSet.has(qt)) score += 1
      }

      // 归一化：避免长文天然高分
      const norm = Math.sqrt(textTokens.length + titleTokens.length * 3) || 1
      const normalized = score / norm
      return {
        content: chunk.text.slice(0, 600),
        source: chunk.sourceTitle,
        sourceId: chunk.sourceId,
        type: chunk.type,
        score: normalized,
        chapterOrder: chunk.chapterOrder,
      }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// Index document chunks
export function indexChunks(novelId: string, chunks: DocumentChunk[]): void {
  chunkStore.set(novelId, chunks)
  markDirty(novelId)
  void persist(novelId)
}

// Add individual chunks
export function addChunk(novelId: string, chunk: DocumentChunk): void {
  const existing = chunkStore.get(novelId) || []
  // Replace if exists
  const idx = existing.findIndex((c) => c.id === chunk.id)
  if (idx >= 0) {
    existing[idx] = chunk
  } else {
    existing.push(chunk)
  }
  chunkStore.set(novelId, existing)
  markDirty(novelId)
  void persist(novelId)
}

// Remove chunk by id
export function removeChunk(novelId: string, chunkId: string): void {
  const existing = chunkStore.get(novelId)
  if (!existing) return
  chunkStore.set(novelId, existing.filter((c) => c.id !== chunkId))
  markDirty(novelId)
  void persist(novelId)
}

// 清空某小说的内存索引（用于测试或重置）
export function clearIndex(novelId: string): void {
  chunkStore.delete(novelId)
}

// 将章节正文切分为固定长度的分块并索引（按段落切分，避免切断句子）
export function indexChapterContent(
  novelId: string,
  chapterId: string,
  chapterTitle: string,
  content: string,
  chapterOrder?: number
): void {
  const paragraphs = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const chunks: DocumentChunk[] = []
  let buffer = ''
  let partIndex = 0
  for (const para of paragraphs) {
    if ((buffer + para).length > 600 && buffer) {
      chunks.push({
        id: `${chapterId}-p${partIndex}`,
        text: buffer,
        type: 'chapter',
        sourceId: chapterId,
        sourceTitle: chapterTitle,
        novelId,
        chapterOrder,
      })
      partIndex++
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n\n${para}` : para
  }
  if (buffer) {
    chunks.push({
      id: `${chapterId}-p${partIndex}`,
      text: buffer,
      type: 'chapter',
      sourceId: chapterId,
      sourceTitle: chapterTitle,
      novelId,
      chapterOrder,
    })
  }
  // 整章替换
  const existing = chunkStore.get(novelId) || []
  const filtered = existing.filter((c) => c.sourceId !== chapterId)
  chunkStore.set(novelId, [...filtered, ...chunks])
  markDirty(novelId)
  void persist(novelId)
}

// 暴露内存分块（供判空/调试）
export function getChunks(novelId: string): DocumentChunk[] {
  return chunkStore.get(novelId) || []
}

// ===== 设定类索引（修复 G3：角色/世界观/伏笔此前从未被索引） =====
export function indexWorldview(novelId: string, id: string, title: string, content: string): void {
  addChunk(novelId, {
    id: `wv-${id}`,
    text: `【世界观·${title}】\n${content}`,
    type: 'worldview',
    sourceId: id,
    sourceTitle: title,
    novelId,
  })
}

export function indexForce(novelId: string, id: string, name: string, content: string): void {
  addChunk(novelId, {
    id: `force-${id}`,
    text: `【势力·${name}】\n${content}`,
    type: 'force',
    sourceId: id,
    sourceTitle: name,
    novelId,
  })
}

export function indexCharacter(novelId: string, id: string, name: string, content: string): void {
  addChunk(novelId, {
    id: `char-${id}`,
    text: `【角色·${name}】\n${content}`,
    type: 'character',
    sourceId: id,
    sourceTitle: name,
    novelId,
  })
}

// ===== P2-10：资产级增量索引（角色/世界观变更时按条 upsert/删除，避免全量重建） =====

/** 角色档案 -> 索引文本（与 indexNovelAssets 的拼装保持一致） */
function buildCharacterProfile(c: Pick<Character, 'role' | 'personality' | 'appearance' | 'profile' | 'dynamicState'>): string {
  return [c.role, c.personality, c.appearance, c.profile, c.dynamicState]
    .filter(Boolean).join('\n')
}

/** 单条角色增量 upsert：无可用档案则移除旧分块 */
export function reindexCharacter(novelId: string, c: Character): void {
  const profile = buildCharacterProfile(c)
  if (!profile) {
    removeChunk(novelId, `char-${c.id}`)
    return
  }
  indexCharacter(novelId, c.id, c.name, profile)
}

/** 单条世界观增量 upsert：无内容则移除旧分块 */
export function reindexWorldview(novelId: string, w: Worldview): void {
  if (!w.content?.trim()) {
    removeChunk(novelId, `wv-${w.id}`)
    return
  }
  indexWorldview(novelId, w.id, w.title, w.content)
}

/** 按来源 id 移除分块（删除角色/世界观等资产时调用） */
export function removeCharacterIndex(novelId: string, id: string): void {
  removeChunk(novelId, `char-${id}`)
}

export function removeWorldviewIndex(novelId: string, id: string): void {
  removeChunk(novelId, `wv-${id}`)
}

export function indexForeshadowing(novelId: string, id: string, content: string, title = '伏笔'): void {
  addChunk(novelId, {
    id: `fs-${id}`,
    text: `【伏笔】${content}`,
    type: 'foreshadowing',
    sourceId: id,
    sourceTitle: title,
    novelId,
  })
}

export function indexChapterSummary(novelId: string, id: string, title: string, summary: string, order?: number): void {
  if (!summary) return
  addChunk(novelId, {
    id: `sum-${id}`,
    text: `【第${order ?? '?'}章 摘要】${title}：${summary}`,
    type: 'chapter',
    sourceId: id,
    sourceTitle: title,
    novelId,
    chapterOrder: order,
  })
}

// 把整本小说的设定/角色/伏笔/章节摘要一次性灌入索引
export async function indexNovelAssets(novelId: string): Promise<void> {
  try {
    const [worlds, chars, fos, volumes, forces] = await Promise.all([
      worldviewService.getByNovelId(novelId),
      characterService.getByNovelId(novelId),
      foreshadowingService.getByNovelId(novelId),
      volumeService.getByNovelId(novelId),
      forceService.getByNovelId(novelId),
    ])
    for (const w of worlds) indexWorldview(novelId, w.id, w.title, w.content)
    for (const fc of forces) {
      const content = [fc.level, fc.description, fc.protagonistRelation, fc.coreMembers, fc.territory]
        .filter(Boolean).join('\n')
      if (content) indexForce(novelId, fc.id, fc.name, content)
    }
    for (const c of chars) reindexCharacter(novelId, c)
    for (const f of fos) indexForeshadowing(novelId, f.id, f.content)
    for (const v of volumes) {
      const chapters = await chapterService.getByVolumeId(v.id)
      for (const ch of chapters) {
        if (ch.summary) indexChapterSummary(novelId, ch.id, ch.title, ch.summary, ch.order)
      }
    }
  } catch (e) {
    console.error('indexNovelAssets failed:', e)
  }
}

// Hybrid search: keyword + contextual boost
export function search(
  query: string,
  novelId: string,
  topK: number = 5
): SearchResult[] {
  const chunks = chunkStore.get(novelId) || []
  if (chunks.length === 0) return []

  return keywordSearch(query, chunks, topK)
}

// Build context string from search results for prompt injection
export function buildContextString(results: SearchResult[]): string {
  if (results.length === 0) return ''

  const parts: string[] = ['## 相关上下文片段']

  results.forEach((r, i) => {
    const prefix = r.type === 'character' ? '角色' :
      r.type === 'setting' ? '设定' :
      r.type === 'foreshadowing' ? '伏笔' :
      r.type === 'worldview' ? '世界观' : '章节'
    parts.push(`### [${prefix}] ${r.source} (相关度: ${r.score.toFixed(2)})`)
    parts.push(r.content)
    if (i < results.length - 1) parts.push('---')
  })

  return parts.join('\n\n')
}
