/**
 * 写作 Agent 工具层（文档 M2 核心修复 / G4）。
 *
 * 旧架构下 AI 是纯 chat，SKILL.md 里"读取大纲/角色/世界观"全是空话——
 * 因为根本没有 function calling 能力。本模块提供一组工具，让 AI 能主动
 * 调取资料、检索上下文、提交追踪，真正具备 agent 能力。
 */
import type { AgentTool, AgentToolResult, Chapter, Volume } from '@shared/types'

const api = () => window.electronAPI
import { OpenAIToolDef } from './llm-service'
import {
  novelService,
  volumeService,
  chapterService,
  characterService,
  worldviewService,
  forceService,
  foreshadowingService,
} from './data-service'
import {
  loadTrackingState,
  generateStateCard,
  generateForeshadowView,
  commitChapterAndSave,
} from './tracking-service'
import { indexChapterSummary } from './rag-service'
import { knowledgeService, type ChapterBriefJSON } from './knowledge-service'

/**
 * 将可能包含对象的数组归一化为 string[]。
 * AI 调用工具时常传 [{content, importance?}] 等对象数组，
 * 而底层服务期望 string[]。此函数按指定字段提取字符串。
 */
function normalizeToStringArray(arr: unknown, field: string): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') return String((item as any)[field] ?? '')
      return String(item)
    })
    .filter((s) => s.length > 0)
}

const readContent = async (c?: Chapter): Promise<string | undefined> => {
  if (!c?.contentPath) return undefined
  try {
    const exists = await api().file.exists(c.contentPath)
    if (!exists) return undefined
    return await api().file.read(c.contentPath)
  } catch {
    return undefined
  }
}

const flatChapters = async (novelId: string): Promise<Chapter[]> => {
  const volumes = (await volumeService.getByNovelId(novelId)) as Volume[]
  const all: Chapter[] = []
  for (const v of volumes) {
    const chs = (await chapterService.getByVolumeId(v.id)) as Chapter[]
    all.push(...chs)
  }
  return all.sort((a, b) => a.order - b.order)
}

export function getWritingTools(novelId: string, chapterId?: string): AgentTool[] {
  return [
    {
      name: 'get_novel_profile',
      description: '获取本书基础设定：书名、简介、题材、目标平台、当前进度、下一步方向。每次正式写作前应先调用以校准基调。优先读知识库 novel.md（信息更丰富），SQLite 兜底。',
      parameters: {},
      handler: async () => {
        // 优先读知识库 novel.md
        try {
          const kbMd = await knowledgeService.read(novelId, 'novel.md')
          if (kbMd) {
            const novel = (await novelService.getById(novelId)) as any
            // 解析 frontmatter + 正文
            const lines = kbMd.split('\n')
            const titleMatch = lines.find((l) => l.startsWith('title:'))
            const novelMatch = lines.join('\n').match(/## 一句话简介\n([^\n]*)/)
            const positionMatch = lines.join('\n').match(/## 当前阶段\n([^\n]*)/)
            const directionMatch = lines.join('\n').match(/## 下一步方向\n([^\n]*)/)
            return {
              title: titleMatch ? titleMatch.replace('title: 《', '').replace('》', '').trim() : novel?.title ?? '',
              description: novelMatch ? novelMatch[1] : novel?.description ?? '',
              genre: novel?.genre ?? [],
              targetPlatform: novel?.targetPlatform ?? '',
              currentPosition: positionMatch ? positionMatch[1] : '',
              nextDirection: directionMatch ? directionMatch[1] : '',
              source: 'knowledge-base',
            }
          }
        } catch { /* fallthrough to sqlite */ }
        // SQLite 兜底
        const novel = (await novelService.getById(novelId)) as any
        if (!novel) return { error: '未找到小说信息' }
        return {
          title: novel.title,
          description: novel.description ?? '',
          genre: novel.genre ?? [],
          targetPlatform: novel.targetPlatform ?? '',
          source: 'sqlite',
        }
      },
    },
    {
      name: 'get_outline',
      description: '获取全书大纲：各卷主题与每章的摘要、细纲(hooks)。用于确认情节走向与本章定位。优先读知识库 outline.md（更清晰），SQLite 兜底。',
      parameters: {},
      handler: async () => {
        // 优先读知识库 outline.md
        try {
          const kbOutline = await knowledgeService.read(novelId, 'outline.md')
          if (kbOutline && kbOutline.length > 50) {
            // 仍然从 SQLite 补全 chapter id 信息（KB outline.md 不含 id）
            const volumes = (await volumeService.getByNovelId(novelId)) as Volume[]
            const idMap: Record<string, string> = {}
            for (const v of volumes) {
              const chs = (await chapterService.getByVolumeId(v.id)) as Chapter[]
              for (const c of chs) {
                idMap[`${v.order}_${c.order}`] = c.id
              }
            }
            return { outline: kbOutline, source: 'knowledge-base', chapterIds: idMap }
          }
        } catch { /* fallthrough */ }
        // SQLite 兜底
        const volumes = (await volumeService.getByNovelId(novelId)) as Volume[]
        const parts: string[] = []
        for (const v of volumes) {
          const chs = (await chapterService.getByVolumeId(v.id)) as Chapter[]
          parts.push(`卷：《${v.title}》（${v.summary || '暂无卷纲'}）`)
          for (const c of chs) {
            parts.push(
              `  - id=${c.id} 第${c.order}章 《${c.title}》 摘要=${c.summary || '无'}；细纲(hooks)=${c.hooks?.join(' / ') || '无'}`,
            )
          }
        }
        return { outline: parts.join('\n') || '（暂无大纲）', source: 'sqlite' }
      },
    },
    {
      name: 'get_character',
      description: '按姓名/身份/关键词检索角色档案（性格、外貌、简介、当前状态）。当需要让某角色出场或说话时调用。',
      parameters: {
        query: { type: 'string', description: '角色姓名或关键词；留空则返回全部角色列表' },
      },
      handler: async (args: { query?: string }) => {
        const chars = (await characterService.getByNovelId(novelId)) as any[]
        const q = (args.query || '').toLowerCase()
        const list = q
          ? chars.filter(
              (c) =>
                (c.name || '').toLowerCase().includes(q) ||
                (c.role || '').toLowerCase().includes(q) ||
                (c.profile || '').toLowerCase().includes(q),
            )
          : chars
        return {
          characters: list.map((c) => ({
            name: c.name,
            role: c.role,
            personality: c.personality,
            appearance: c.appearance,
            profile: c.profile,
            dynamicState: c.dynamicState,
          })),
        }
      },
    },
    {
      name: 'get_worldview',
      description: '检索世界观/设定（力量体系、地理、历史、修炼、社会等）。当写作涉及设定规则时调用以确保不偏离。',
      parameters: {
        query: { type: 'string', description: '设定关键词，如"灵气""境界""宗门"；留空返回全部设定' },
      },
      handler: async (args: { query?: string }) => {
        const worlds = (await worldviewService.getByNovelId(novelId)) as any[]
        const q = (args.query || '').toLowerCase()
        const list = q
          ? worlds.filter(
              (w) => (w.title + w.content).toLowerCase().includes(q),
            )
          : worlds
        return {
          worldviews: list.map((w) => ({
            title: w.title,
            category: w.category,
            content: w.content,
          })),
        }
      },
    },
    {
      name: 'get_force',
      description: '检索势力/组织档案（门派、宗门、帝国、家族、组织等）。当写作涉及势力关系、阵营对抗、归属阵营时调用以确保一致。',
      parameters: {
        query: { type: 'string', description: '势力关键词，如"宗门""帝国""家族"；留空返回全部势力' },
      },
      handler: async (args: { query?: string }) => {
        const forces = (await forceService.getByNovelId(novelId)) as any[]
        const q = (args.query || '').toLowerCase()
        const list = q
          ? forces.filter(
              (f) => (f.name + f.type + f.description + (f.territory || '')).toLowerCase().includes(q),
            )
          : forces
        return {
          forces: list.map((f) => ({
            name: f.name,
            type: f.type,
            level: f.level,
            description: f.description,
            protagonistRelation: f.protagonistRelation,
            coreMembers: f.coreMembers,
            territory: f.territory,
          })),
        }
      },
    },
    {
      name: 'get_tracking_state',
      description: '获取创作追踪状态：已收章节、活跃伏笔、角色参与、时间线、连续性备忘。用于保持跨章一致。优先读知识库 foreshadowings.md + hooks.md（叙事化），tracking-state.json 兜底（机器态）。',
      parameters: {},
      handler: async () => {
        const state = await loadTrackingState(novelId)
        // 优先读知识库的伏笔账本与钩子地图
        let kbForeshadowings = ''
        let kbHooks = ''
        try {
          kbForeshadowings = await knowledgeService.read(novelId, 'foreshadowings.md') ?? ''
          kbHooks = await knowledgeService.read(novelId, 'hooks.md') ?? ''
        } catch { /* ignore */ }
        return {
          stateCard: generateStateCard(state),
          foreshadowView: kbForeshadowings || generateForeshadowView(state),
          hooksView: kbHooks || '',
          source: kbForeshadowings ? 'knowledge-base' : 'tracking-state',
        }
      },
    },
    {
      name: 'get_chapter_context',
      description: '获取某章及其前后章的概要/正文，用于承接上下文、保持续写连贯。默认当前章。',
      parameters: {
        chapterId: { type: 'string', description: '章节 ID；留空使用当前章节' },
      },
      handler: async (args: { chapterId?: string }) => {
        const all = await flatChapters(novelId)
        const targetId = args.chapterId || chapterId
        const idx = all.findIndex((c) => c.id === targetId)
        const prev = idx > 0 ? all[idx - 1] : undefined
        const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : undefined
        // 从知识库读取本章简要（含伏笔变更与下章钩子）
        let brief: string | undefined
        if (targetId) {
          try {
            brief = await knowledgeService.read(novelId, `chapters/${targetId}.md`) ?? undefined
          } catch { /* ignore */ }
        }
        return {
          current: targetId && all[idx]
            ? { title: all[idx].title, order: all[idx].order, summary: all[idx].summary, content: await readContent(all[idx]) }
            : undefined,
          prev: prev
            ? { title: prev.title, order: prev.order, summary: prev.summary, content: await readContent(prev) }
            : undefined,
          // 下一章只给规划 hooks 不给摘要：未来章摘要多为旧版规划文本，防剧透污染（同 context-assembler）
          next: next ? { title: next.title, order: next.order, hooks: next.hooks ?? [] } : undefined,
          brief,
        }
      },
    },
    {
      name: 'commit_tracking',
      description: '将本章关键信息写入创作追踪（摘要、出场角色、新增/回收伏笔、关键事件），供后续章节保持连续。仅在本章内容已基本确定后调用。可选 chapterBrief 字段会同步写入知识库 chapters/<chId>.md + hooks.md + foreshadowings.md。',
      parameters: {
        summary: { type: 'string', description: '本章内容摘要（1-3 句）' },
        charactersInvolved: {
          type: 'array',
          description: '出场角色：[{characterId, name, role, stateAfter?}]',
        },
        keyEvents: { type: 'array', description: '本章关键情节事件列表' },
        newForeshadowings: { type: 'array', description: '新增伏笔：[{content, importance?, plannedResolveChapter?}]' },
        resolvedForeshadowings: { type: 'array', description: '已回收伏笔 id 列表' },
        wordCount: { type: 'number', description: '本章字数' },
        content: {
          type: 'string',
          description: '本章正文全文（强烈建议提供）。提供后会先落盘到本章文件再提交追踪；不提供时若章节文件为空将提交失败，此时请先调用 rewrite_chapter 写回正文。',
        },
        coveredHooks: {
          type: 'array',
          description: '本章细纲(hooks)节点的自报覆盖清单：列出本章正文实际出现的每个 hook 节点。若提供且存在未覆盖节点，将返回 ok:false 并列出 missing，请补写后再提交。不提供则跳过覆盖校验（不阻断提交）。',
        },
        chapterBrief: {
          type: 'object',
          description: '可选：本章结构化简要，提供后会同步写入知识库。格式 {summary, keyEvents, charactersInvolved, newForeshadowings, resolvedForeshadowings, nextChapterHook}',
        },
      },
      handler: async (args: any) => {
        const targetId = chapterId
        if (!targetId) return { error: '当前未在具体章节上下文，无法提交追踪' }
        const chapter = await chapterService.getById(targetId)
        if (!chapter) return { error: '章节不存在' }

        // IMP-07：大纲节点覆盖校验（修复 R3——hooks 拿到但不校验）。
        // 模型自报 coveredHooks 时，逐条比对本章 hooks；漏项返回 ok:false 并列出 missing，
        // 迫使模型补写缺失节点（SKILL.md 规则 11：漏一个即重写）。未自报则跳过（不阻断）。
        const chapterHooks: string[] = Array.isArray((chapter as any).hooks) ? (chapter as any).hooks : []
        if (Array.isArray(args.coveredHooks) && chapterHooks.length > 0) {
          const covered = args.coveredHooks.map((h: unknown) => String(h))
          const missing = chapterHooks.filter((h) => !covered.includes(h))
          if (missing.length > 0) {
            return {
              ok: false,
              error: '大纲 hooks 未全覆盖，提交被拦截',
              missing,
              covered,
              required: chapterHooks,
              hint: '请补写漏掉的 hook 节点（或明确以改写理由覆盖），再调用 commit_tracking。规则：本章 hooks 每个节点都必须出现，漏一个即重写。',
            }
          }
        }

        try {
          await commitChapterAndSave(novelId, {
            chapterId: targetId,
            chapterTitle: chapter.title,
            summary: args.summary || chapter.summary || '',
            wordCount: args.wordCount || chapter.wordCount || 0,
            keyEvents: normalizeToStringArray(args.keyEvents, 'event'),
            charactersInvolved: normalizeToStringArray(args.charactersInvolved, 'name'),
            newForeshadowings: normalizeToStringArray(args.newForeshadowings, 'content'),
            resolvedForeshadowings: normalizeToStringArray(args.resolvedForeshadowings, 'content'),
            plotQuestions: [],
            // IMP-03：把正文一并落盘，修"DB 显示完成但 md 为空"
            content: typeof args.content === 'string' ? args.content : undefined,
          })
        } catch (e: any) {
          // IMP-03：空正文提交失败时不要让 agent 循环卡死，给出明确的下一步
          return {
            ok: false,
            error: e?.message || '提交追踪失败',
            hint: '请先调用 rewrite_chapter 把本章正文写回，再提交追踪',
          }
        }
        // 知识库联动：若提供了 chapterBrief，写入 KB
        if (args.chapterBrief && typeof args.chapterBrief === 'object') {
          try {
            const brief: ChapterBriefJSON = {
              summary: args.chapterBrief.summary || args.summary || '',
              keyEvents: normalizeToStringArray(args.chapterBrief.keyEvents || args.keyEvents, 'event'),
              charactersInvolved: normalizeToStringArray(args.chapterBrief.charactersInvolved || args.charactersInvolved, 'name'),
              newForeshadowings: normalizeToStringArray(args.chapterBrief.newForeshadowings || args.newForeshadowings, 'content'),
              resolvedForeshadowings: normalizeToStringArray(args.chapterBrief.resolvedForeshadowings || args.resolvedForeshadowings, 'content'),
              nextChapterHook: args.chapterBrief.nextChapterHook || '',
            }
            await knowledgeService.applyChapterBrief(novelId, targetId, brief)
          } catch (e) {
            console.warn('[commit_tracking] kb apply failed:', e)
          }
        }
        return { ok: true, message: '已提交本章追踪状态' + (args.chapterBrief ? '（已同步知识库）' : '') }
      },
    },
    {
      name: 'rewrite_chapter',
      description:
        '将改写后的章节正文整体写回并落盘（用于第一/第三人称视角转换、润色、扩写等整章改写）。必须提供完整的新正文，会整体覆盖原文件，并刷新字数、状态与跨章召回索引。',
      parameters: {
        chapterId: { type: 'string', description: '目标章节 ID（来自 get_outline 的 id 字段）' },
        newContent: { type: 'string', description: '改写后的完整章节正文（非空，将覆盖原文件）' },
        summary: { type: 'string', description: '可选，本章新摘要；提供后会更新追踪并灌入跨章索引' },
      },
      handler: async (args: { chapterId?: string; newContent?: string; summary?: string }) => {
        const id = args.chapterId
        if (!id) return { error: '缺少 chapterId' }
        const content = args.newContent
        if (typeof content !== 'string' || !content.trim()) return { error: 'newContent 不能为空' }
        const chapter = await chapterService.getById(id)
        if (!chapter) return { error: '章节不存在' }
        try {
          await chapterService.saveContent(id, content, { source: 'ai', novelId })
          await chapterService.update(id, {
            status: 'polished',
            summary: args.summary ?? chapter.summary,
          })
          if (args.summary) {
            indexChapterSummary(novelId, id, chapter.title, args.summary, chapter.order)
          }
          // 查询卷序号和卷内章节位置，显示"第X卷第Y章"而非全局序号
          const volChapters = await chapterService.getByVolumeId(chapter.volumeId)
          const positionInVolume = volChapters.findIndex((c) => c.id === id) + 1
          const volRows = (await api().db.query('SELECT order_num, title FROM volumes WHERE id = ?', [chapter.volumeId])) as any[]
          const volOrder = volRows[0]?.order_num ?? 0
          const volTitle = volRows[0]?.title ?? ''
          return {
            ok: true,
            message: `已写回第${volOrder}卷《${volTitle}》第${positionInVolume}章《${chapter.title}》`,
            wordCount: content.length,
          }
        } catch (e) {
          return { error: `写回失败：${(e as Error).message}` }
        }
      },
    },
    {
      name: 'search_knowledge_base',
      description: '检索知识库（叙事层真相之源）：可查任意章节的简要（chapters/）、任意卷的主线与卷尾钩子（volumes/）、角色档案与出场记录（characters/）、世界观条目（worldviews/）、全书总览与进度（novel.md）、伏笔账本状态（foreshadowings.md）、钩子地图（hooks.md）、爽点曲线（arc.md）。用于解决"写到哪里、接下来该怎么写、某角色上次出场是哪章、某伏笔是否已回收、本卷主线是什么、下章该接什么钩子"等导航问题。scope 可限定检索范围以提高精度。',
      parameters: {
        query: { type: 'string', description: '自然语言提问，如"苏婉第一次出场是哪章""第15章埋了什么伏笔""本卷主线是什么"' },
        scope: { type: 'string', description: '检索范围：novel/current_volume/current_chapter/foreshadowings/hooks/characters/worldviews/all；默认 all', enum: ['novel', 'current_volume', 'current_chapter', 'foreshadowings', 'hooks', 'characters', 'worldviews', 'all'] },
      },
      handler: async (args: { query?: string; scope?: string }) => {
        const query = args.query || ''
        if (!query) return { error: 'query 不能为空' }
        try {
          const result = await knowledgeService.search(novelId, query, args.scope)
          return result
        } catch (e) {
          return { error: `知识库检索失败：${(e as Error).message}` }
        }
      },
    },
    {
      name: 'rebuild_knowledge_base',
      description: '一键从 SQLite 重建整个知识库。当发现知识库内容与实际小说数据严重不一致（如章节摘要缺失、角色档案过时、伏笔状态错误、卷概要不同步）时调用。会清空旧知识库并从 SQLite 重新同步全部卷/章/角色/世界观/伏笔数据。注意：重建后之前手动编辑的知识库内容会丢失。',
      parameters: {},
      handler: async () => {
        try {
          await knowledgeService.rebuildFromSQLite(novelId)
          return { ok: true, message: '知识库已从 SQLite 重建完成' }
        } catch (e) {
          return { error: `知识库重建失败：${(e as Error).message}` }
        }
      },
    },
    {
      name: 'auto_build_knowledge_base',
      description: 'AI 自动构建知识库：逐章读取正文并用 LLM 提取摘要、关键事件、出场角色、伏笔和钩子，自动写入知识库。处理完全部章节后还会生成全书概要。适用于导入小说后或知识库内容缺失时自动填充。注意：这是一个耗时操作，会为每章发起一次 LLM 调用。',
      parameters: {},
      handler: async () => {
        try {
          const { autoBuildKnowledgeBase } = await import('./kb-auto-build')
          let lastProgress = ''
          for await (const p of autoBuildKnowledgeBase(novelId)) {
            if (p.phase === 'chapter' && p.total > 0) {
              lastProgress = `${p.index + 1}/${p.total} 章`
            } else if (p.phase === 'done') {
              lastProgress = p.message || '完成'
            } else if (p.phase === 'error') {
              return { error: p.message || 'AI 构建失败' }
            }
          }
          return { ok: true, message: `AI 构建知识库完成：${lastProgress}` }
        } catch (e) {
          return { error: `AI 构建失败：${(e as Error).message}` }
        }
      },
    },
  ]
}

// AgentTool[] → OpenAI function-calling schema
export function toOpenAISchema(tools: AgentTool[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.parameters).map(([k, v]) => [
            k,
            { type: v.type, description: v.description, ...(v.enum ? { enum: v.enum } : {}) },
          ]),
        ),
        required: Object.keys(t.parameters),
      },
    },
  }))
}

export async function executeTool(
  name: string,
  args: any,
  tools: AgentTool[],
): Promise<AgentToolResult> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return { id: '', name, success: false, result: null, error: `未知工具：${name}` }
  }
  try {
    const result = await tool.handler(args || {})
    return { id: '', name, success: true, result }
  } catch (e) {
    return { id: '', name, success: false, result: null, error: (e as Error).message }
  }
}
