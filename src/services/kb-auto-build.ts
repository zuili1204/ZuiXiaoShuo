/**
 * AI 自动构建知识库（Knowledge Base Auto-Build）。
 *
 * 逐章读取正文 → LLM 提取摘要/关键事件/出场角色/伏笔/钩子 → 写入知识库。
 * 处理完全部章节后，再让 LLM 生成全书概要写入 novel.md + volumes/*.md。
 *
 * 架构：每章单独跑一次聚焦的 LLM 调用（async generator 逐章产出进度），
 * 避免上下文爆炸导致模型退化。
 */
import { chapterService, volumeService, agentConfigService } from './data-service'
import { agentChat } from './agent-service'
import { knowledgeService, type ChapterBriefJSON, type NovelSummaryJSON } from './knowledge-service'
import type { AgentConfig } from '@shared/types'

export interface AutoBuildProgress {
  phase: 'chapter' | 'summary' | 'done' | 'error'
  index: number
  total: number
  chapterId?: string
  title?: string
  message?: string
}

export interface AutoBuildOptions {
  /** 仅处理「有正文但无摘要」的章节（续写前自动补剧情记忆用），已有摘要的章节跳过 */
  onlyMissing?: boolean
}

function extractJson(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

/**
 * 自动构建知识库：逐章 LLM 提取 + 全书总结。
 * @param novelId 小说 ID
 * @param signal 可选取消信号
 */
export async function* autoBuildKnowledgeBase(
  novelId: string,
  signal?: AbortController['signal'],
  options?: AutoBuildOptions,
): AsyncGenerator<AutoBuildProgress> {
  // 1. 获取活跃 agent 配置（优先用 writer 角色，否则取第一个）
  const agents = await agentConfigService.getAll()
  if (agents.length === 0) {
    yield { phase: 'error', index: 0, total: 0, message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  const agent: AgentConfig = agents.find((a) => a.role === 'writer') || agents[0]

  // 2. 初始化知识库骨架
  await knowledgeService.initKnowledgeBaseForExistingNovel(novelId)

  // 3. 扁平化所有章节
  const volumes = await volumeService.getByNovelId(novelId)
  const allChapters: { id: string; title: string; order: number; volumeId: string; summary: string }[] = []
  for (const v of volumes) {
    const chs = await chapterService.getByVolumeId(v.id)
    for (const ch of chs) {
      allChapters.push({ id: ch.id, title: ch.title, order: ch.order, volumeId: v.id, summary: ch.summary ?? '' })
    }
  }
  const total = allChapters.length
  if (total === 0) {
    yield { phase: 'error', index: 0, total: 0, message: '该小说暂无章节' }
    return
  }

  // 4. 逐章提取
  const chapterSummaries: { order: number; title: string; summary: string }[] = []

  /** 调用 LLM 提取单章信息（含空响应重试） */
  async function extractChapterBrief(
    agent: AgentConfig, novelId: string, ch: { id: string; title: string; order: number; volumeId: string },
    content: string, signal?: AbortController['signal'],
  ): Promise<string> {
    const buildPrompt = (text: string) =>
      `你是一名小说分析助手。请阅读以下章节正文，提取结构化信息。\n` +
      `输出纯 JSON（不要 Markdown 代码块、不要解释），格式如下：\n` +
      `{\n` +
      `  "summary": "1-3句话概括本章核心情节",\n` +
      `  "keyEvents": ["关键事件1", "关键事件2", ...],\n` +
      `  "charactersInvolved": ["出场角色姓名1", "角色2", ...],\n` +
      `  "newForeshadowings": ["本章新埋设的伏笔描述", ...],\n` +
      `  "resolvedForeshadowings": ["本章回收的伏笔描述", ...],\n` +
      `  "nextChapterHook": "下一章应该承接的悬念或钩子"\n` +
      `}\n\n` +
      `==== 章节标题 ====\n第${ch.order}章 ${ch.title}\n\n` +
      `==== 章节正文 ====\n${text.slice(0, 12000)}`

    for (let attempt = 0; attempt < 2; attempt++) {
      let acc = ''
      for await (const chunk of agentChat(
        agent,
        buildPrompt(content),
        {
          novelId,
          volumeId: ch.volumeId,
          chapterId: ch.id,
          chapterTitle: ch.title,
          chapterOrder: ch.order,
          chapterSummary: '',
          previousMessages: [],
          mode: 'chat',
          agentMode: 'ask',
          enableTools: false,
        },
        signal,
      )) {
        if (chunk.content) acc += chunk.content
        if (signal?.aborted) return ''
      }

      if (acc.trim()) return acc

      // 空响应：等待 2 秒后重试
      if (attempt === 0) {
        console.warn(`[kb-auto-build] Chapter ${ch.order} 返回空响应，2 秒后重试...`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    return ''
  }

  for (let i = 0; i < allChapters.length; i++) {
    const ch = allChapters[i]
    yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title }

    // onlyMissing：已有摘要的章节不重复提取，但摘要仍计入全书总结
    if (options?.onlyMissing && ch.summary.trim()) {
      chapterSummaries.push({ order: ch.order, title: ch.title, summary: ch.summary })
      yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: '已有摘要，跳过' }
      continue
    }

    try {
      const content = await chapterService.loadContent(ch.id)
      if (!content || !content.trim()) {
        yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: '正文为空，跳过' }
        continue
      }

      const acc = await extractChapterBrief(agent, novelId, ch, content, signal)
      if (signal?.aborted) return

      // 解析 JSON
      const jsonStr = extractJson(acc)
      if (jsonStr) {
        try {
          const brief = JSON.parse(jsonStr) as Partial<ChapterBriefJSON>
          const chapterBrief: ChapterBriefJSON = {
            summary: brief.summary || '',
            keyEvents: Array.isArray(brief.keyEvents) ? brief.keyEvents.map(String) : [],
            charactersInvolved: Array.isArray(brief.charactersInvolved) ? brief.charactersInvolved.map(String) : [],
            newForeshadowings: Array.isArray(brief.newForeshadowings) ? brief.newForeshadowings.map(String) : [],
            resolvedForeshadowings: Array.isArray(brief.resolvedForeshadowings) ? brief.resolvedForeshadowings.map(String) : [],
            nextChapterHook: brief.nextChapterHook || '',
          }

          // 写入知识库
          await knowledgeService.applyChapterBrief(novelId, ch.id, chapterBrief)

          // 同时更新 SQLite 中的 summary（供大纲/导出使用）
          if (chapterBrief.summary) {
            await chapterService.update(ch.id, { summary: chapterBrief.summary })
          }

          chapterSummaries.push({ order: ch.order, title: ch.title, summary: chapterBrief.summary })
          yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: '完成' }
        } catch (parseErr) {
          console.error('[kb-auto-build] JSON parse failed for chapter', ch.order, ':', parseErr, '\nRaw:', acc.slice(0, 200))
          // 降级：用 LLM 原始输出的前 200 字作为摘要
          const fallbackSummary = acc.replace(/```json|```/g, '').trim().slice(0, 200)
          if (fallbackSummary) {
            const chapterBrief: ChapterBriefJSON = {
              summary: fallbackSummary,
              keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: [],
              nextChapterHook: '',
            }
            await knowledgeService.applyChapterBrief(novelId, ch.id, chapterBrief)
            await chapterService.update(ch.id, { summary: fallbackSummary })
            chapterSummaries.push({ order: ch.order, title: ch.title, summary: fallbackSummary })
            yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: '完成（降级）' }
          } else {
            yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: 'JSON 解析失败，跳过' }
          }
        }
      } else {
        console.error('[kb-auto-build] No JSON found in LLM output for chapter', ch.order, '\nRaw:', acc.slice(0, 200))
        // 降级：用 LLM 原始输出的前 200 字作为摘要
        const fallbackSummary = acc.trim().slice(0, 200)
        if (fallbackSummary) {
          const chapterBrief: ChapterBriefJSON = {
            summary: fallbackSummary,
            keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: [],
            nextChapterHook: '',
          }
          await knowledgeService.applyChapterBrief(novelId, ch.id, chapterBrief)
          await chapterService.update(ch.id, { summary: fallbackSummary })
          chapterSummaries.push({ order: ch.order, title: ch.title, summary: fallbackSummary })
          yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: '完成（降级）' }
        } else {
          yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: 'LLM 返回空内容，跳过' }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      console.error('[kb-auto-build] Chapter', ch.order, 'failed:', e)
      yield { phase: 'chapter', index: i, total, chapterId: ch.id, title: ch.title, message: `错误: ${(e as Error).message}` }
    }

    // 章节间延迟 1 秒，避免 API 速率限制
    if (i < allChapters.length - 1) {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  // 5. 全书总结
  if (chapterSummaries.length > 0) {
    yield { phase: 'summary', index: 0, total: 1, message: '正在生成全书概要...' }

    try {
      const summaryList = chapterSummaries
        .map((s) => `第${s.order}章《${s.title}》：${s.summary}`)
        .join('\n')

      const summaryPrompt =
        `你是一名小说分析助手。以下是本书各章的摘要，请基于此生成全书概要。\n` +
        `输出纯 JSON（不要 Markdown 代码块、不要解释），格式如下：\n` +
        `{\n` +
        `  "novel_summary": "全书一句话到三句话概括",\n` +
        `  "volume_summaries": [\n` +
        `    {"volumeId": "卷ID", "title": "卷标题", "theme": "卷主题", "mainPlot": "卷主线", "endingHook": "卷尾钩子"}\n` +
        `  ],\n` +
        `  "current_position": {"volume": 1, "chapter": ${chapterSummaries.length}, "title": "最新章节标题"},\n` +
        `  "next_direction": "下一步方向建议"\n` +
        `}\n\n` +
        `==== 各章摘要 ====\n${summaryList.slice(0, 8000)}`

      let summaryAcc = ''
      for await (const chunk of agentChat(
        agent,
        summaryPrompt,
        {
          novelId,
          previousMessages: [],
          mode: 'chat',
          agentMode: 'ask',
          enableTools: false,
        },
        signal,
      )) {
        if (chunk.content) summaryAcc += chunk.content
        if (signal?.aborted) return
      }

      const summaryJsonStr = extractJson(summaryAcc)
      if (summaryJsonStr) {
        try {
          const summary = JSON.parse(summaryJsonStr) as Partial<NovelSummaryJSON>
          // 补全卷 ID（LLM 可能不知道真实 ID）
          const vols = await volumeService.getByNovelId(novelId)
          if (summary.volume_summaries && Array.isArray(summary.volume_summaries)) {
            summary.volume_summaries = summary.volume_summaries.map((vs, idx) => ({
              volumeId: vols[idx]?.id || vs.volumeId || '',
              title: vs.title || vols[idx]?.title || '',
              theme: vs.theme || '',
              mainPlot: vs.mainPlot || '',
              endingHook: vs.endingHook || '',
            }))
          }
          await knowledgeService.applyNovelSummary(novelId, summary as NovelSummaryJSON)
        } catch {
          // 总结 JSON 解析失败不影响已完成章节
        }
      }

      // 同步角色和世界观（从 SQLite 提取已有数据）
      await knowledgeService.syncCharacters(novelId)
      await knowledgeService.syncWorldviews(novelId)
      await knowledgeService.syncOutline(novelId)
      await knowledgeService.syncForeshadowings(novelId)
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      // 总结失败不影响已完成章节
    }
  }

  yield { phase: 'done', index: total, total, message: `完成：共处理 ${chapterSummaries.length}/${total} 章` }
}

/**
 * 统计「有正文但无摘要」的章节数。
 * 导入的旧书/脚本搬入的正文没有剧情总结层（大纲简报、人物卡全空），
 * 续写时生成器只能靠卷摘要撑前情，极易剧情漂移——这个数就是缺失的剧情记忆量。
 */
export async function countMissingSummaries(novelId: string): Promise<number> {
  const volumes = await volumeService.getByNovelId(novelId)
  let missing = 0
  for (const v of volumes) {
    const chs = await chapterService.getByVolumeId(v.id)
    for (const ch of chs) {
      if ((ch.wordCount ?? 0) > 0 && !(ch.summary ?? '').trim()) missing++
    }
  }
  return missing
}

/**
 * 续写前的剧情记忆保障：检测到缺失摘要时自动构建知识库（只补缺失章节），
 * 无缺失时不产生任何 LLM 调用。挂在写作入口（流水线 / AI 对话写作模式）最前面。
 */
export async function* ensureStoryMemory(
  novelId: string,
  signal?: AbortController['signal'],
): AsyncGenerator<AutoBuildProgress> {
  const missing = await countMissingSummaries(novelId)
  if (missing === 0) {
    yield { phase: 'done', index: 0, total: 0, message: '剧情记忆完整，无需构建' }
    return
  }
  yield { phase: 'summary', index: 0, total: 1, message: `检测到 ${missing} 章缺少剧情摘要，先自动构建剧情记忆...` }
  yield* autoBuildKnowledgeBase(novelId, signal, { onlyMissing: true })
}
