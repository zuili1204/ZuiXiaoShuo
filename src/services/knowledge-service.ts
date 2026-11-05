/**
 * 知识库服务（Knowledge Base Service）
 *
 * 一本小说一个知识库，互相独立，互不干扰。
 * 知识库是 AI 撰写小说时的"导航地图 + 真相之源"——它回答四个问题：
 * 1. 目前写到哪里（进度指针 + 最近 N 章摘要）
 * 2. 接下来该怎么写（下一章细纲 + 钩子 + 待回收伏笔）
 * 3. 大致方向是什么（全书情绪/爽点曲线 + 卷主线 + 终局储备）
 * 4. 大概内容又是什么（每卷概要 + 每章简要 + 角色档案 + 世界观条目）
 *
 * 与现有三个"记忆系统"互补：
 * - SQLite 表：结构化权威数据（行+列）
 * - tracking-state.json：机器状态账本（计数器+列表）
 * - rag/<novelId>.json：模糊召回索引（文本分块+关键词）
 * - knowledge/<novelId>/（本模块）：叙事层真相之源（分层 markdown + 元数据 JSON）
 */

import type { Chapter, Volume, Character, Worldview, Novel, Force } from '@shared/types'
import {
  novelService,
  volumeService,
  chapterService,
  characterService,
  worldviewService,
  forceService,
  foreshadowingService,
} from './data-service'
import { loadTrackingState } from './tracking-service'
import { loadIndex, search as ragSearch, indexChapterSummary } from './rag-service'
import { ActionLog } from './log-service'

const api = () => window.electronAPI

// ===== 类型定义 =====

export interface KBIndexMeta {
  kbVersion: string
  novelId: string
  lastUpdated: string
  files: Record<string, { hash: string; generator: string; updatedAt: string }>
}

export interface ChapterBriefJSON {
  summary: string
  keyEvents: string[]
  charactersInvolved: string[]
  newForeshadowings: string[]
  resolvedForeshadowings: string[]
  nextChapterHook: string
}

export interface NovelSummaryJSON {
  novel_summary: string
  volume_summaries: { volumeId: string; title: string; theme: string; mainPlot: string; endingHook: string }[]
  current_position: { volume: number; chapter: number; title: string }
  next_direction: string
}

export interface KBSearchResult {
  answer: string
  sources: { file: string; section: string; snippet: string; lineNumber?: number }[]
  relatedFiles: string[]
}

export interface KBFileMeta {
  path: string
  generator: string
  updatedAt: string
  size: number
}

// ===== 路径工具 =====

function kbRoot(novelId: string): string {
  return `content/knowledge/${novelId}`
}

function kbPath(novelId: string, relative: string): string {
  return `${kbRoot(novelId)}/${relative}`
}

// ===== 原子文件读写 =====

async function fileExists(path: string): Promise<boolean> {
  try {
    return !!(await api().file.exists?.(path))
  } catch {
    return false
  }
}

async function readFileText(path: string): Promise<string | null> {
  try {
    const exists = await fileExists(path)
    if (!exists) return null
    return await api().file.read(path)
  } catch {
    return null
  }
}

async function writeFileText(path: string, content: string): Promise<void> {
  try {
    await api().file.write(path, content)
  } catch (e) {
    console.error('[kb] writeFileText failed:', path, e)
  }
}

async function deleteFile(path: string): Promise<void> {
  try {
    const exists = await fileExists(path)
    if (exists) await api().file.delete(path)
  } catch {
    /* ignore */
  }
}

async function ensureDir(path: string): Promise<void> {
  // 主进程 file-service.mkdir 内部已用 fs.mkdir(recursive: true)，无需逐层创建
  try {
    await api().file.mkdir(path)
  } catch {
    // 目录创建失败时，通过写一个 .gitkeep 兜底（writeFile 自身也会递归建目录）
    try {
      await api().file.write(`${path}/.gitkeep`, '')
    } catch {
      /* ignore */
    }
  }
}

// 简单 hash（非加密用途，仅用于变更检测）
function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `h${(h >>> 0).toString(16)}`
}

// ===== index.json 维护 =====

async function readIndex(novelId: string): Promise<KBIndexMeta> {
  const raw = await readFileText(kbPath(novelId, 'index.json'))
  if (!raw) {
    return { kbVersion: '1.0', novelId, lastUpdated: new Date().toISOString(), files: {} }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { kbVersion: '1.0', novelId, lastUpdated: new Date().toISOString(), files: {} }
  }
}

async function writeIndex(novelId: string, index: KBIndexMeta): Promise<void> {
  index.lastUpdated = new Date().toISOString()
  await writeFileText(kbPath(novelId, 'index.json'), JSON.stringify(index, null, 2))
}

async function updateIndexEntry(
  novelId: string,
  relativePath: string,
  generator: string,
): Promise<void> {
  const index = await readIndex(novelId)
  const content = await readFileText(kbPath(novelId, relativePath))
  index.files[relativePath] = {
    hash: content ? simpleHash(content) : '',
    generator,
    updatedAt: new Date().toISOString(),
  }
  await writeIndex(novelId, index)
}

// ===== 公共 API =====

export const knowledgeService = {
  // ---------- 初始化 ----------

  /** 新建小说时调用：创建知识库骨架。 */
  async initKnowledgeBase(novelId: string, novel?: Novel | null): Promise<void> {
    const root = kbRoot(novelId)
    await ensureDir(root)
    await ensureDir(kbPath(novelId, 'volumes'))
    await ensureDir(kbPath(novelId, 'chapters'))
    await ensureDir(kbPath(novelId, 'characters'))
    await ensureDir(kbPath(novelId, 'worldviews'))
    await ensureDir(kbPath(novelId, 'forces'))

    // novel.md
    const n = novel ?? (await novelService.getById(novelId))
    const novelMd = this._buildNovelMd(novelId, n, {
      novel_summary: n?.description || '（待补充）',
      current_position: { volume: 0, chapter: 0, title: '尚未开书' },
      next_direction: '请先完成立项与设定阶段，生成卷纲与章纲后开始正文。',
      volume_summaries: [],
    })
    await writeFileText(kbPath(novelId, 'novel.md'), novelMd)

    // outline.md（空骨架）
    await writeFileText(kbPath(novelId, 'outline.md'), '# 全书大纲\n\n（暂无卷纲，请使用 story-outline-gen 生成）\n')

    // foreshadowings.md
    await writeFileText(kbPath(novelId, 'foreshadowings.md'), '# 伏笔账本\n\n## 活跃（待回收）\n\n（暂无）\n\n## 已回收\n\n（暂无）\n')

    // hooks.md
    await writeFileText(kbPath(novelId, 'hooks.md'), '# 钩子地图\n\n## 未兑现\n\n（暂无）\n\n## 已兑现\n\n（暂无）\n')

    // arc.md
    await writeFileText(kbPath(novelId, 'arc.md'), '# 情绪/爽点曲线\n\n（请使用 story-arc-design 生成节拍表）\n')

    // index.json
    const index: KBIndexMeta = {
      kbVersion: '1.0',
      novelId,
      lastUpdated: new Date().toISOString(),
      files: {},
    }
    await writeIndex(novelId, index)
    await updateIndexEntry(novelId, 'novel.md', 'init')
    await updateIndexEntry(novelId, 'outline.md', 'init')
    await updateIndexEntry(novelId, 'foreshadowings.md', 'init')
    await updateIndexEntry(novelId, 'hooks.md', 'init')
    await updateIndexEntry(novelId, 'arc.md', 'init')
  },

  /** 老书首次访问时自动从 SQLite + tracking-state 生成初始版本。 */
  async initKnowledgeBaseForExistingNovel(novelId: string): Promise<void> {
    const exists = await fileExists(kbPath(novelId, 'index.json'))
    if (exists) return // 已初始化

    const novel = await novelService.getById(novelId)
    await this.initKnowledgeBase(novelId, novel)

    // 从 SQLite 同步已有数据
    await this.syncCharacters(novelId)
    await this.syncWorldviews(novelId)
    await this.syncForces(novelId)
    await this.syncOutline(novelId)
    await this.syncForeshadowings(novelId)

    // 同步已有章节摘要
    const volumes = await volumeService.getByNovelId(novelId)
    for (const v of volumes) {
      const chapters = await chapterService.getByVolumeId(v.id)
      for (const ch of chapters) {
        if (ch.summary) {
          await this._writeChapterMd(novelId, ch, ch.summary, [], [], [], [], '')
        }
      }
    }
  },

  // ---------- 基础读写 ----------

  async read(novelId: string, relativePath: string): Promise<string | null> {
    return readFileText(kbPath(novelId, relativePath))
  },

  async write(novelId: string, relativePath: string, content: string, generator: string): Promise<void> {
    // 确保目录存在
    const dir = relativePath.includes('/')
      ? relativePath.split('/').slice(0, -1).join('/')
      : ''
    if (dir) await ensureDir(kbPath(novelId, dir))
    await writeFileText(kbPath(novelId, relativePath), content)
    await updateIndexEntry(novelId, relativePath, generator)
  },

  async delete(novelId: string, relativePath: string): Promise<void> {
    await deleteFile(kbPath(novelId, relativePath))
    const index = await readIndex(novelId)
    delete index.files[relativePath]
    await writeIndex(novelId, index)
  },

  async deleteAll(novelId: string): Promise<void> {
    // 逐文件删除（兼容 file.delete 不支持递归的情况）
    const index = await readIndex(novelId)
    const allFiles = Object.keys(index.files)
    for (const f of allFiles) {
      await deleteFile(kbPath(novelId, f))
    }
    // 再尝试删除根目录下的剩余文件
    for (const sub of ['novel.md', 'outline.md', 'arc.md', 'foreshadowings.md', 'hooks.md', 'index.json']) {
      await deleteFile(kbPath(novelId, sub))
    }
  },

  // ---------- 文件枚举（供 UI 浏览）----------

  /** 枚举知识库所有文件及其元数据，供 UI 文件树展示。 */
  async listFiles(novelId: string): Promise<KBFileMeta[]> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const index = await readIndex(novelId)
    const result: KBFileMeta[] = []
    for (const [path, meta] of Object.entries(index.files)) {
      const content = await readFileText(kbPath(novelId, path))
      result.push({
        path,
        generator: meta.generator,
        updatedAt: meta.updatedAt,
        size: content ? content.length : 0,
      })
    }
    // 按路径排序，确保目录结构稳定
    result.sort((a, b) => a.path.localeCompare(b.path))
    return result
  },

  // ---------- 检索 ----------

  async search(novelId: string, query: string, scope?: string): Promise<KBSearchResult> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    await loadIndex(novelId)

    const scopeMap: Record<string, string[]> = {
      novel: ['novel.md'],
      current_volume: ['novel.md', 'volumes/'],
      current_chapter: ['chapters/'],
      foreshadowings: ['foreshadowings.md'],
      hooks: ['hooks.md'],
      characters: ['characters/'],
      worldviews: ['worldviews/'],
      forces: ['forces/'],
      all: [],
    }
    const scopeFilter = scope ? scopeMap[scope] ?? [] : []

    // 先用 RAG 检索（已经索引的章节摘要/角色/世界观/伏笔）
    const ragResults = ragSearch(query, novelId, 5)

    // 再加载相关 KB 文件做精排
    const index = await readIndex(novelId)
    const candidateFiles: string[] = []
    for (const f of Object.keys(index.files)) {
      if (scopeFilter.length === 0) {
        candidateFiles.push(f)
      } else {
        for (const sf of scopeFilter) {
          if (sf.endsWith('/') ? f.startsWith(sf) : f === sf) {
            candidateFiles.push(f)
            break
          }
        }
      }
    }

    const sources: KBSearchResult['sources'] = []
    const relatedFiles: string[] = []
    const snippets: string[] = []

    // 检查 RAG 结果
    for (const r of ragResults) {
      snippets.push(`[${r.source}] ${r.content.slice(0, 200)}`)
      sources.push({
        file: r.type === 'character' ? `characters/` : r.type === 'worldview' ? `worldviews/` : r.type === 'force' ? `forces/` : `chapters/`,
        section: r.source,
        snippet: r.content.slice(0, 200),
      })
    }

    // 在 KB 文件中做关键词匹配
    const qLower = query.toLowerCase()
    const qTokens = qLower.split(/\s+/).filter(Boolean)
    for (const f of candidateFiles.slice(0, 20)) {
      const content = await readFileText(kbPath(novelId, f))
      if (!content) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase()
        if (qTokens.some((t) => lineLower.includes(t))) {
          const start = Math.max(0, i - 1)
          const end = Math.min(lines.length, i + 2)
          const snippet = lines.slice(start, end).join('\n').trim().slice(0, 200)
          sources.push({ file: f, section: `L${i + 1}`, snippet, lineNumber: i + 1 })
          if (!relatedFiles.includes(f)) relatedFiles.push(f)
          break // 每文件只取第一个命中
        }
      }
    }

    const answer = snippets.length
      ? snippets.slice(0, 5).join('\n---\n')
      : '知识库中未找到相关内容。'

    return { answer, sources: sources.slice(0, 10), relatedFiles: relatedFiles.slice(0, 10) }
  },

  // ---------- 章节摘要落库 ----------

  async applyChapterBrief(
    novelId: string,
    chapterId: string,
    brief: ChapterBriefJSON,
  ): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const chapter = await chapterService.getById(chapterId)
    if (!chapter) {
      console.warn('[kb] applyChapterBrief: chapter not found:', chapterId)
      return
    }

    // 写 chapters/<chId>.md
    await this._writeChapterMd(
      novelId,
      chapter,
      brief.summary,
      brief.keyEvents,
      brief.charactersInvolved,
      brief.newForeshadowings,
      brief.resolvedForeshadowings,
      brief.nextChapterHook,
    )

    // 若有下章钩子，追加到 hooks.md
    if (brief.nextChapterHook) {
      await this._appendToHooks(novelId, chapter, brief.nextChapterHook)
    }

    // 更新伏笔账本
    await this._updateForeshadowingsMd(novelId, chapter, brief.newForeshadowings, brief.resolvedForeshadowings)

    // 更新 volumes/<volId>.md 进度
    await this._updateVolumeProgress(novelId, chapter, brief)

    // 更新 novel.md 进度
    await this._updateNovelProgress(novelId, chapter, brief)

    // 重新索引 RAG
    try {
      indexChapterSummary(novelId, chapter.id, chapter.title, brief.summary, chapter.order)
    } catch (e) {
      console.warn('[kb] reindex chapter summary failed:', e)
    }

    // 记录知识库写入结果
    ActionLog.kb('写入章节简要', { novelId, chapterId, title: chapter.title, summary: brief.summary.slice(0, 80) })
  },

  // ---------- 全书概要落库 ----------

  async applyNovelSummary(novelId: string, summary: NovelSummaryJSON): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const novel = await novelService.getById(novelId)

    // 写 novel.md
    const novelMd = this._buildNovelMd(novelId, novel, summary)
    await this.write(novelId, 'novel.md', novelMd, 'story-summarize')

    // 写各卷概要
    for (const vs of summary.volume_summaries) {
      await this._writeVolumeMd(novelId, vs.volumeId, vs.title, vs.theme, vs.mainPlot, vs.endingHook)
    }

    // 记录知识库写入结果
    ActionLog.kb('写入全书概要', { novelId, currentPosition: summary.current_position, volumes: summary.volume_summaries.length })
  },

  // ---------- 爽点曲线落库 ----------

  async applyArcDesign(novelId: string, arcContent: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const md = `# 情绪/爽点曲线\n\n${arcContent}\n`
    await this.write(novelId, 'arc.md', md, 'story-arc-design')
    ActionLog.kb('写入爽点曲线', { novelId, lines: arcContent.split('\n').length })
  },

  // ---------- 同步 SQLite → KB ----------

  async syncCharacters(novelId: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const chars = await characterService.getByNovelId(novelId)
    // 先读 tracking-state 获取角色参与章节
    const tracking = await loadTrackingState(novelId)
    for (const c of chars) {
      await this._writeCharacterMd(novelId, c, tracking.characterInvolvements[c.name] || [])
    }
    // 删除 KB 中已不存在的角色文件
    const index = await readIndex(novelId)
    const charFiles = Object.keys(index.files).filter((f) => f.startsWith('characters/'))
    for (const f of charFiles) {
      const id = f.replace('characters/', '').replace('.md', '')
      if (!chars.find((c) => c.id === id)) {
        await this.delete(novelId, f)
      }
    }
  },

  async syncWorldviews(novelId: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const wvs = await worldviewService.getByNovelId(novelId)
    for (const w of wvs) {
      await this._writeWorldviewMd(novelId, w)
    }
    const index = await readIndex(novelId)
    const wvFiles = Object.keys(index.files).filter((f) => f.startsWith('worldviews/'))
    for (const f of wvFiles) {
      const id = f.replace('worldviews/', '').replace('.md', '')
      if (!wvs.find((w) => w.id === id)) {
        await this.delete(novelId, f)
      }
    }
  },

  async syncForces(novelId: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const forces = await forceService.getByNovelId(novelId)
    for (const f of forces) {
      await this._writeForceMd(novelId, f)
    }
    // 清理已删除的势力 KB 文件
    const index = await readIndex(novelId)
    const forceFiles = Object.keys(index.files).filter((ff) => ff.startsWith('forces/'))
    for (const ff of forceFiles) {
      const id = ff.replace('forces/', '').replace('.md', '')
      if (!forces.find((f) => f.id === id)) {
        await this.delete(novelId, ff)
      }
    }
  },

  async syncOutline(novelId: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const novel = await novelService.getById(novelId)
    const volumes = await volumeService.getByNovelId(novelId)
    const parts: string[] = ['# 全书大纲\n']
    if (novel?.masterOutline?.trim()) {
      parts.push('## 主线', novel.masterOutline.trim(), '')
    }
    for (const v of volumes) {
      const chapters = await chapterService.getByVolumeId(v.id)
      parts.push(`\n## 第${v.order}卷《${v.title}》`)
      if (v.summary) parts.push(`卷纲：${v.summary}`)
      if (v.goal) parts.push(`卷目标：${v.goal}`)
      if (v.climax) parts.push(`卷末高潮：${v.climax}`)
      if (v.endingHook) parts.push(`卷尾钩子：${v.endingHook}`)
      if (v.estimatedChapters) parts.push(`预计章数：${v.estimatedChapters}`)
      if (v.targetWordCount) parts.push(`目标字数：${v.targetWordCount}`)
      for (const c of chapters) {
        const hooks = c.hooks?.length ? `｜细纲：${c.hooks.join('；')}` : ''
        parts.push(`- 第${c.order}章《${c.title}》${c.summary ? ` — ${c.summary}` : ''}${hooks}`)
      }
    }
    await this.write(novelId, 'outline.md', parts.join('\n'), 'sync-outline')
  },

  async syncForeshadowings(novelId: string): Promise<void> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const fos = await foreshadowingService.getByNovelId(novelId)
    const active = fos.filter((f) => f.status === 'planted')
    const resolved = fos.filter((f) => f.status === 'resolved')
    const lines: string[] = ['# 伏笔账本\n', '## 活跃（待回收）']
    if (active.length === 0) lines.push('（暂无）')
    for (const f of active) {
      lines.push(`- [第${f.plantedChapter}章 埋设] ${f.content}${f.plannedResolveChapter ? ` (计划回收: 第${f.plannedResolveChapter}章)` : ''}`)
    }
    lines.push('', '## 已回收')
    if (resolved.length === 0) lines.push('（暂无）')
    for (const f of resolved) {
      lines.push(`- [第${f.plantedChapter}章 埋设 → 第${f.resolvedChapter ?? '?'}章 回收] ${f.content}`)
    }
    await this.write(novelId, 'foreshadowings.md', lines.join('\n'), 'sync-foreshadowings')
  },

  /** 一键从 SQLite 重建整个知识库（用于老书或数据不一致时）。 */
  async rebuildFromSQLite(novelId: string): Promise<void> {
    const novel = await novelService.getById(novelId)
    // 1. 清空旧知识库
    await this.deleteAll(novelId)
    // 2. 重新初始化骨架
    await this.initKnowledgeBase(novelId, novel)
    // 3. 同步全部结构化数据
    await this.syncCharacters(novelId)
    await this.syncWorldviews(novelId)
    await this.syncForces(novelId)
    await this.syncOutline(novelId)
    await this.syncForeshadowings(novelId)
    // 4. 遍历所有章节，写入章节简要
    const volumes = await volumeService.getByNovelId(novelId)
    for (const v of volumes) {
      // 写卷概要
      await this._writeVolumeMd(novelId, v.id, v.title, v.summary || '', '', '')
      const chapters = await chapterService.getByVolumeId(v.id)
      for (const ch of chapters) {
        if (ch.summary) {
          await this._writeChapterMd(novelId, ch, ch.summary, [], [], [], [], '')
        }
      }
    }
    ActionLog.kb('重建知识库', { novelId, volumes: volumes.length })
  },

  // ---------- 导航层上下文装配 ----------

  /** 装配"导航层"上下文，供 context-assembler 注入 system prompt 开头。 */
  async assembleNavigationContext(
    novelId: string,
    currentChapterId?: string,
    opts?: { excludeCurrentChapterBrief?: boolean },
  ): Promise<string> {
    await this.initKnowledgeBaseForExistingNovel(novelId)
    const L: string[] = []

    // 1. novel.md（总览）
    const novelMd = await this.read(novelId, 'novel.md')
    if (novelMd) {
      L.push('═══ 知识库·小说总览 ═══')
      L.push(novelMd)
      L.push('')
    }

    // 2. 当前卷概要
    let currentVolume: Volume | undefined
    if (currentChapterId) {
      const ch = await chapterService.getById(currentChapterId)
      if (ch) {
        const volumes = await volumeService.getByNovelId(novelId)
        currentVolume = volumes.find((v) => v.id === ch.volumeId)
        if (currentVolume) {
          const volMd = await this.read(novelId, `volumes/${currentVolume.id}.md`)
          L.push('═══ 知识库·当前卷 ═══')
          L.push(volMd || `第${currentVolume.order}卷《${currentVolume.title}》：${currentVolume.summary || '（暂无卷概要）'}`)
          L.push('')
        }
      }
    }

    // 3. 当前章节简要
    // excludeCurrentChapterBrief：重生成模式下 KB 的当前章 md 由旧摘要生成，
    // 注入会把废弃版本剧情当既定事实喂给 writer（2026-10-05 事故泄漏源之一）
    if (currentChapterId && !opts?.excludeCurrentChapterBrief) {
      const chMd = await this.read(novelId, `chapters/${currentChapterId}.md`)
      if (chMd) {
        L.push('═══ 知识库·当前章节简要 ═══')
        L.push(chMd)
        L.push('')
      }
    }

    // 4. 伏笔账本
    const fsMd = await this.read(novelId, 'foreshadowings.md')
    if (fsMd) {
      L.push('═══ 知识库·伏笔账本 ═══')
      L.push(fsMd)
      L.push('')
    }

    // 5. 钩子地图
    const hooksMd = await this.read(novelId, 'hooks.md')
    if (hooksMd) {
      L.push('═══ 知识库·钩子地图 ═══')
      L.push(hooksMd)
      L.push('')
    }

    // 6. 势力概要
    const forces = await forceService.getByNovelId(novelId)
    if (forces.length > 0) {
      L.push('═══ 知识库·势力格局 ═══')
      for (const f of forces) {
        L.push(`- ${f.name}（${f.type}）${f.level ? ` · ${f.level}` : ''}${f.protagonistRelation ? ` · 与主角：${f.protagonistRelation}` : ''}`)
      }
      L.push('')
    }

    return L.join('\n')
  },

  // ---------- 删除联动 ----------

  async onChapterDeleted(novelId: string, chapterId: string): Promise<void> {
    await this.delete(novelId, `chapters/${chapterId}.md`)
    await this.syncOutline(novelId)
    await this.syncForeshadowings(novelId)
  },

  async onVolumeDeleted(novelId: string, volumeId: string): Promise<void> {
    await this.delete(novelId, `volumes/${volumeId}.md`)
    // 删除该卷下所有章节文件：先查 SQLite 获取章节 id 列表（若尚未级联删除）
    try {
      const chapters = await chapterService.getByVolumeId(volumeId)
      for (const ch of chapters) {
        await this.delete(novelId, `chapters/${ch.id}.md`)
      }
    } catch {
      /* SQLite 中卷/章可能已被删除，忽略 */
    }
    await this.syncOutline(novelId)
  },

  async onCharacterDeleted(novelId: string, characterId: string): Promise<void> {
    await this.delete(novelId, `characters/${characterId}.md`)
  },

  async onWorldviewDeleted(novelId: string, worldviewId: string): Promise<void> {
    await this.delete(novelId, `worldviews/${worldviewId}.md`)
  },

  async onForceDeleted(novelId: string, forceId: string): Promise<void> {
    await this.delete(novelId, `forces/${forceId}.md`)
  },

  // ===== 私有：模板构建 =====

  _buildNovelMd(novelId: string, novel: Novel | null | undefined, summary: NovelSummaryJSON): string {
    const L: string[] = []
    L.push('---')
    L.push(`novelId: ${novelId}`)
    L.push(`title: 《${novel?.title ?? '未命名'}》`)
    L.push(`genre: ${Array.isArray(novel?.genre) ? (novel!.genre as string[]).join(', ') : '未设定'}`)
    L.push(`targetPlatform: ${novel?.targetPlatform ?? '未设定'}`)
    L.push(`currentVolume: ${summary.current_position?.volume ?? 0}`)
    L.push(`currentChapter: ${summary.current_position?.chapter ?? 0}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push(`kbVersion: 1.0`)
    L.push('---')
    L.push('')
    L.push('# 小说总览')
    L.push('')
    L.push('## 一句话简介')
    L.push(summary.novel_summary || novel?.description || '（待补充）')
    L.push('')
    L.push('## 当前阶段')
    if (summary.current_position) {
      L.push(`第 ${summary.current_position.volume} 卷 · 第 ${summary.current_position.chapter} 章${summary.current_position.title ? `《${summary.current_position.title}》` : ''}`)
    } else {
      L.push('尚未开书')
    }
    L.push('')
    L.push('## 下一步方向')
    L.push(summary.next_direction || '（待 story-summarize 产出）')
    L.push('')
    return L.join('\n')
  },

  async _writeChapterMd(
    novelId: string,
    chapter: Chapter,
    summary: string,
    keyEvents: string[],
    charactersInvolved: string[],
    newForeshadowings: string[],
    resolvedForeshadowings: string[],
    nextChapterHook: string,
  ): Promise<void> {
    // 从 chapter.volumeId 查卷序
    let volumeOrder = 0
    try {
      const rows = (await api().db.query('SELECT order_num FROM volumes WHERE id = ?', [chapter.volumeId])) as any[]
      volumeOrder = rows[0]?.order_num ?? 0
    } catch { /* ignore */ }

    const L: string[] = []
    L.push('---')
    L.push(`chapterId: ${chapter.id}`)
    L.push(`order: ${chapter.order}`)
    L.push(`volumeOrder: ${volumeOrder}`)
    L.push(`title: ${chapter.title}`)
    L.push(`wordCount: ${chapter.wordCount ?? 0}`)
    L.push(`status: ${chapter.status}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push('---')
    L.push('')
    L.push(`# 第${chapter.order}章《${chapter.title}》`)
    L.push('')
    L.push('## 摘要')
    L.push(summary || '（待补充）')
    L.push('')
    if (charactersInvolved.length) {
      L.push('## 出场角色')
      for (const c of charactersInvolved) L.push(`- ${c}`)
      L.push('')
    }
    if (keyEvents.length) {
      L.push('## 关键事件')
      for (let i = 0; i < keyEvents.length; i++) L.push(`${i + 1}. ${keyEvents[i]}`)
      L.push('')
    }
    if (newForeshadowings.length || resolvedForeshadowings.length) {
      L.push('## 伏笔变更')
      for (const f of newForeshadowings) L.push(`- 新增：[第${chapter.order}章] ${f}`)
      for (const f of resolvedForeshadowings) L.push(`- 回收：${f}`)
      L.push('')
    }
    if (nextChapterHook) {
      L.push('## 下章钩子')
      L.push(nextChapterHook)
      L.push('')
    }
    await this.write(novelId, `chapters/${chapter.id}.md`, L.join('\n'), 'story-chapter-summary')
  },

  async _writeVolumeMd(
    novelId: string,
    volumeId: string,
    title: string,
    theme: string,
    mainPlot: string,
    endingHook: string,
  ): Promise<void> {
    let order = 0
    let chapterCount = 0
    let wordCount = 0
    try {
      const rows = (await api().db.query('SELECT order_num FROM volumes WHERE id = ?', [volumeId])) as any[]
      order = rows[0]?.order_num ?? 0
      const chs = await chapterService.getByVolumeId(volumeId)
      chapterCount = chs.length
      wordCount = chs.reduce((s, c) => s + (c.wordCount ?? 0), 0)
    } catch { /* ignore */ }

    const L: string[] = []
    L.push('---')
    L.push(`volumeId: ${volumeId}`)
    L.push(`order: ${order}`)
    L.push(`title: ${title}`)
    L.push(`chapterCount: ${chapterCount}`)
    L.push(`wordCount: ${wordCount}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push('---')
    L.push('')
    L.push(`# 第${order}卷《${title}》`)
    L.push('')
    L.push('## 卷主题')
    L.push(theme || '（待补充）')
    L.push('')
    L.push('## 卷主线')
    L.push(mainPlot || '（待补充）')
    L.push('')
    L.push('## 卷尾钩子')
    L.push(endingHook || '（待补充）')
    L.push('')
    await this.write(novelId, `volumes/${volumeId}.md`, L.join('\n'), 'story-summarize')
  },

  async _writeCharacterMd(novelId: string, c: Character, involvement: string[]): Promise<void> {
    const L: string[] = []
    L.push('---')
    L.push(`characterId: ${c.id}`)
    L.push(`name: ${c.name}`)
    L.push(`role: ${c.role}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push('---')
    L.push('')
    L.push(`# 角色：${c.name}（${c.role}）`)
    L.push('')
    if (c.gender) L.push(`性别：${c.gender}`)
    if (c.age) L.push(`年龄：${c.age}`)
    if (c.personality) L.push(`性格：${c.personality}`)
    if (c.appearance) L.push(`外貌：${c.appearance}`)
    if (c.profile) L.push(`简介：${c.profile}`)
    if (c.dynamicState) L.push(`当前状态：${c.dynamicState}`)
    L.push('')
    if (involvement.length) {
      L.push('## 出场章节')
      for (const ch of involvement) L.push(`- ${ch}`)
      L.push('')
    }
    await this.write(novelId, `characters/${c.id}.md`, L.join('\n'), 'sync-character')
  },

  async _writeWorldviewMd(novelId: string, w: Worldview): Promise<void> {
    const L: string[] = []
    L.push('---')
    L.push(`worldviewId: ${w.id}`)
    L.push(`category: ${w.category}`)
    L.push(`title: ${w.title}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push('---')
    L.push('')
    L.push(`# 世界观：${w.title}（${w.category}）`)
    L.push('')
    L.push(w.content || '（暂无内容）')
    L.push('')
    await this.write(novelId, `worldviews/${w.id}.md`, L.join('\n'), 'sync-worldview')
  },

  async _writeForceMd(novelId: string, f: Force): Promise<void> {
    const L: string[] = []
    L.push('---')
    L.push(`forceId: ${f.id}`)
    L.push(`type: ${f.type}`)
    L.push(`name: ${f.name}`)
    L.push(`lastUpdated: ${new Date().toISOString()}`)
    L.push('---')
    L.push('')
    L.push(`# 势力：${f.name}（${f.type}）`)
    L.push('')
    if (f.level) { L.push(`## 等级/实力`); L.push(f.level); L.push('') }
    L.push('## 描述')
    L.push(f.description || '（暂无描述）')
    L.push('')
    if (f.protagonistRelation) { L.push('## 与主角关系'); L.push(f.protagonistRelation); L.push('') }
    if (f.coreMembers) { L.push('## 核心成员'); L.push(f.coreMembers); L.push('') }
    if (f.territory) { L.push('## 领地/势力范围'); L.push(f.territory); L.push('') }
    await this.write(novelId, `forces/${f.id}.md`, L.join('\n'), 'sync-force')
  },

  async _appendToHooks(novelId: string, chapter: Chapter, hook: string): Promise<void> {
    const existing = await this.read(novelId, 'hooks.md')
    const line = `- [第${chapter.order}章] ${hook}`
    if (existing) {
      // 在"未兑现"段追加
      const updated = existing.replace(
        /## 未兑现\n/,
        `## 未兑现\n${line}\n`,
      )
      await this.write(novelId, 'hooks.md', updated || existing, 'chapter-hook')
    } else {
      const md = `# 钩子地图\n\n## 未兑现\n${line}\n\n## 已兑现\n\n（暂无）\n`
      await this.write(novelId, 'hooks.md', md, 'chapter-hook')
    }
  },

  async _updateForeshadowingsMd(
    novelId: string,
    chapter: Chapter,
    newFs: string[],
    resolvedFs: string[],
  ): Promise<void> {
    // 重新从 SQLite 同步（最权威）
    await this.syncForeshadowings(novelId)
  },

  async _updateVolumeProgress(novelId: string, chapter: Chapter, brief: ChapterBriefJSON): Promise<void> {
    // 更新卷文件的"关键事件"列表
    const volMd = await this.read(novelId, `volumes/${chapter.volumeId}.md`)
    if (!volMd) {
      // 卷文件不存在，创建一个最小骨架
      const vol = (await api().db.query('SELECT * FROM volumes WHERE id = ?', [chapter.volumeId])) as any[]
      if (vol[0]) {
        await this._writeVolumeMd(novelId, vol[0].id, vol[0].title, '', '', '')
      }
      return
    }
    // 在关键事件段追加
    const eventLine = `- 第${chapter.order}章：${brief.summary.slice(0, 60)}`
    if (volMd.includes('## 关键事件')) {
      const updated = volMd.replace(/## 关键事件\n/, `## 关键事件\n${eventLine}\n`)
      await this.write(novelId, `volumes/${chapter.volumeId}.md`, updated, 'chapter-progress')
    } else {
      const updated = `${volMd}\n## 关键事件\n${eventLine}\n`
      await this.write(novelId, `volumes/${chapter.volumeId}.md`, updated, 'chapter-progress')
    }
  },

  async _updateNovelProgress(novelId: string, chapter: Chapter, brief: ChapterBriefJSON): Promise<void> {
    const novelMd = await this.read(novelId, 'novel.md')
    if (!novelMd) return
    // 更新 frontmatter 中的 currentChapter 与 lastUpdated
    const updated = novelMd
      .replace(/currentChapter: \d+/, `currentChapter: ${chapter.order}`)
      .replace(/lastUpdated: [^\n]+/, `lastUpdated: ${new Date().toISOString()}`)
    // 更新"下一步方向"段
    const finalMd = brief.nextChapterHook
      ? updated.replace(/## 下一步方向\n[^\n]*\n?/, `## 下一步方向\n${brief.nextChapterHook}\n`)
      : updated
    await this.write(novelId, 'novel.md', finalMd, 'chapter-progress')
  },
}
