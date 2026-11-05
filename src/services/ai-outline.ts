/**
 * AI 大纲构建与完善服务。
 *
 * 构建大纲（buildOutline）：从章节正文+知识库内容，AI 生成结构化大纲，覆盖写入。
 *   - full：全书大纲（卷纲+章纲），写入 outline.md + 各卷 summary + 各章 summary/hooks
 *   - volume：卷大纲，写入 volume.summary + 该卷各章 summary/hooks
 *   - chapter：章大纲，写入 chapter.summary + hooks
 *   - 无章节时，从知识库内容生成规划性大纲写入 outline.md
 *
 * 完善大纲（refineOutline）：在现有大纲基础上润色增强，支持可选参考范围。
 *
 * 架构参照 kb-auto-build.ts：async generator + agentChat，空响应重试 2 次。
 */
import { chapterService, volumeService, agentConfigService } from './data-service'
import { agentChat } from './agent-service'
import { knowledgeService } from './knowledge-service'
import type { AgentConfig, Volume, Chapter } from '@shared/types'

export interface OutlineProgress {
  phase: 'prepare' | 'llm' | 'write' | 'done' | 'error'
  message?: string
}

export interface BuildOutlineOptions {
  scope: 'full' | 'volume' | 'chapter'
  volumeId?: string
  chapterId?: string
  signal?: AbortSignal
}

export interface RefineOutlineOptions {
  scope: 'full' | 'volume' | 'chapter'
  volumeId?: string
  chapterId?: string
  /** 可选：参考第 X 卷到第 Y 卷的卷大纲（1-based） */
  refVolumeRange?: { start: number; end: number }
  /** 可选：参考第 X 章到第 Y 章的章大纲（1-based 全局章序号） */
  refChapterRange?: { start: number; end: number }
  signal?: AbortSignal
}

// ===== 工具函数（导出供 outline-planner 复用） =====

export function extractJson(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

export async function getAgent(): Promise<AgentConfig | null> {
  const agents = await agentConfigService.getAll()
  if (agents.length === 0) return null
  return agents.find((a) => a.role === 'architect')
    || agents.find((a) => a.role === 'writer')
    || agents[0]
}

export async function callLLM(agent: AgentConfig, novelId: string, prompt: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let acc = ''
    for await (const chunk of agentChat(agent, prompt, {
      novelId,
      previousMessages: [],
      mode: 'chat',
      agentMode: 'ask',
      enableTools: false,
    }, signal)) {
      if (chunk.content) acc += chunk.content
      if (signal?.aborted) return ''
    }
    if (acc.trim()) return acc
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000))
  }
  return ''
}

/** 获取章节摘要（无摘要则取正文前 2000 字） */
export async function getChapterDigest(ch: { id: string; summary?: string }): Promise<string> {
  if (ch.summary && ch.summary.trim()) return ch.summary
  const content = await chapterService.loadContent(ch.id)
  return content ? content.slice(0, 2000) : ''
}

export interface VolChap {
  vol: Volume
  chapters: Chapter[]
}

export async function collectVolumes(novelId: string): Promise<VolChap[]> {
  const volumes = await volumeService.getByNovelId(novelId)
  const result: VolChap[] = []
  for (const v of volumes) {
    // D-T3-2：order 缺失时按出现顺序兜底，避免进度/提示词渲染成「第undefined卷」
    const order = typeof v.order === 'number' ? v.order : result.length + 1
    result.push({ vol: { ...v, order }, chapters: await chapterService.getByVolumeId(v.id) })
  }
  return result
}

/** 构建章节列表文本（标题+摘要节选） */
async function buildChapterListText(vols: VolChap[], digestLen = 500): Promise<string> {
  const parts: string[] = []
  for (const { vol, chapters } of vols) {
    parts.push(`## 第${vol.order}卷《${vol.title}》`)
    for (const c of chapters) {
      const digest = await getChapterDigest(c)
      parts.push(`- 第${c.order}章《${c.title}》：${digest.slice(0, digestLen)}`)
    }
  }
  return parts.join('\n')
}

// ===== 构建大纲 =====

export async function* buildOutline(
  novelId: string,
  options: BuildOutlineOptions,
): AsyncGenerator<OutlineProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  const { scope, volumeId, chapterId, signal } = options
  if (scope === 'chapter') {
    yield* buildChapterOutline(novelId, agent, chapterId!, signal)
  } else if (scope === 'volume') {
    yield* buildVolumeOutline(novelId, agent, volumeId!, signal)
  } else {
    yield* buildFullOutline(novelId, agent, signal)
  }
}

async function* buildFullOutline(
  novelId: string,
  agent: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在收集章节内容…' }
  const vols = await collectVolumes(novelId)
  const hasChapters = vols.some((v) => v.chapters.length > 0)

  if (!hasChapters) {
    // 无章节：从知识库内容构建规划性大纲
    yield { phase: 'llm', message: '无章节，根据知识库内容生成规划性大纲…' }
    const prompt =
      '你是一名小说大纲架构师。请根据知识库中的小说资料（已在上下文注入），生成一份全书规划性大纲。\n' +
      '输出纯文本大纲（Markdown 格式），包含卷标题与卷纲、每卷的章节规划。格式：\n' +
      '# 全书大纲\n\n## 第1卷《卷名》\n卷纲：...\n- 第1章《章名》：章纲摘要\n- 第2章...\n\n## 第2卷...\n'
    const out = await callLLM(agent, novelId, prompt, signal)
    if (signal?.aborted) return
    if (!out.trim()) {
      yield { phase: 'error', message: 'LLM 返回空内容' }
      return
    }
    yield { phase: 'write', message: '正在写入大纲…' }
    await knowledgeService.write(novelId, 'outline.md', out, 'ai-build-outline')
    yield { phase: 'done', message: '全文大纲构建完成（规划性）' }
    return
  }

  // 有章节：从章节正文/摘要+知识库构建
  yield { phase: 'llm', message: '正在生成全文大纲…' }
  const chapterList = await buildChapterListText(vols, 500)
  const prompt =
    '你是一名小说大纲架构师。请基于以下章节内容（标题+摘要/正文节选），结合知识库设定，为全书生成结构化大纲。\n' +
    '输出纯 JSON（不要 Markdown 代码块），格式：\n' +
    '{\n  "volumes": [\n    {\n      "summary": "本卷卷纲（主线、主题、起承转合）",\n' +
    '      "chapters": [\n        { "summary": "本章摘要", "hooks": ["细纲要点1", "细纲要点2"] }\n      ]\n    }\n  ]\n}\n' +
    '注意：volumes 和 chapters 数组顺序必须与输入章节顺序一一对应。\n\n' +
    `==== 章节内容 ====\n${chapterList.slice(0, 16000)}`

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入大纲…' }
  try {
    const data = JSON.parse(jsonStr) as {
      volumes?: { summary?: string; chapters?: { summary?: string; hooks?: string[] }[] }[]
    }
    const out = Array.isArray(data.volumes) ? data.volumes : []
    for (let i = 0; i < out.length && i < vols.length; i++) {
      const v = out[i]
      if (v.summary) await volumeService.update(vols[i].vol.id, { summary: v.summary })
      const chs = v.chapters ?? []
      for (let j = 0; j < chs.length && j < vols[i].chapters.length; j++) {
        const c = chs[j]
        if (!c) continue
        await chapterService.update(vols[i].chapters[j].id, {
          summary: c.summary || '',
          hooks: Array.isArray(c.hooks) ? c.hooks.map(String) : [],
        })
      }
    }
    await knowledgeService.syncOutline(novelId)
    yield { phase: 'done', message: '全文大纲构建完成' }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}

async function* buildVolumeOutline(
  novelId: string,
  agent: AgentConfig,
  volumeId: string,
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在收集卷内容…' }
  const vols = await collectVolumes(novelId)
  const target = vols.find((v) => v.vol.id === volumeId)
  if (!target) {
    yield { phase: 'error', message: '未找到该卷' }
    return
  }
  if (target.chapters.length === 0) {
    yield { phase: 'error', message: '该卷暂无章节' }
    return
  }

  yield { phase: 'llm', message: `正在生成第${target.vol.order}卷大纲…` }
  const chText = await buildChapterListText([target], 800)
  const prompt =
    '你是一名小说大纲架构师。请基于以下卷内章节内容，结合知识库设定，为该卷生成结构化大纲。\n' +
    '输出纯 JSON：\n' +
    '{"summary":"卷纲","chapters":[{"summary":"章摘要","hooks":["细纲1","细纲2"]}]}\n' +
    'chapters 顺序必须与输入一一对应。\n\n' +
    `==== 第${target.vol.order}卷《${target.vol.title}》章节 ====\n${chText.slice(0, 16000)}`

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入卷大纲…' }
  try {
    const data = JSON.parse(jsonStr) as { summary?: string; chapters?: { summary?: string; hooks?: string[] }[] }
    if (data.summary) await volumeService.update(volumeId, { summary: data.summary })
    const chs = data.chapters ?? []
    for (let i = 0; i < chs.length && i < target.chapters.length; i++) {
      const c = chs[i]
      if (!c) continue
      await chapterService.update(target.chapters[i].id, {
        summary: c.summary || '',
        hooks: Array.isArray(c.hooks) ? c.hooks.map(String) : [],
      })
    }
    await knowledgeService.syncOutline(novelId)
    yield { phase: 'done', message: '卷大纲构建完成' }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}

async function* buildChapterOutline(
  novelId: string,
  agent: AgentConfig,
  chapterId: string,
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在读取章节正文…' }
  const ch = await chapterService.getById(chapterId)
  if (!ch) {
    yield { phase: 'error', message: '未找到该章' }
    return
  }
  const content = await chapterService.loadContent(chapterId)
  if (!content.trim()) {
    yield { phase: 'error', message: '该章正文为空' }
    return
  }

  yield { phase: 'llm', message: `正在生成第${ch.order}章大纲…` }
  const prompt =
    '你是一名小说大纲架构师。请基于以下章节正文，结合知识库设定，生成该章的章纲（摘要+细纲）。\n' +
    '输出纯 JSON：\n{"summary":"本章摘要（1-3句）","hooks":["细纲要点1","细纲要点2",...]}\n\n' +
    `==== 第${ch.order}章《${ch.title}》正文 ====\n${content.slice(0, 12000)}`

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入章大纲…' }
  try {
    const data = JSON.parse(jsonStr) as { summary?: string; hooks?: string[] }
    await chapterService.update(chapterId, {
      summary: data.summary || '',
      hooks: Array.isArray(data.hooks) ? data.hooks.map(String) : [],
    })
    await knowledgeService.syncOutline(novelId)
    yield { phase: 'done', message: '章大纲构建完成' }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}

// ===== 完善大纲 =====

export async function* refineOutline(
  novelId: string,
  options: RefineOutlineOptions,
): AsyncGenerator<OutlineProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent' }
    return
  }
  const { scope, volumeId, chapterId, refVolumeRange, refChapterRange, signal } = options
  if (scope === 'chapter') {
    yield* refineChapterOutline(novelId, agent, chapterId!, refVolumeRange, refChapterRange, signal)
  } else if (scope === 'volume') {
    yield* refineVolumeOutline(novelId, agent, volumeId!, refVolumeRange, signal)
  } else {
    yield* refineFullOutline(novelId, agent, signal)
  }
}

async function* refineFullOutline(
  novelId: string,
  agent: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在读取现有大纲…' }
  const existing = (await knowledgeService.read(novelId, 'outline.md')) ?? ''
  if (!existing.trim()) {
    yield { phase: 'error', message: '暂无全文大纲，请先构建大纲' }
    return
  }

  yield { phase: 'llm', message: '正在润色全文大纲…' }
  const prompt =
    '你是一名小说大纲润色专家。请基于以下现有全文大纲，结合知识库设定，进行润色完善。\n' +
    '要求：补充缺失的卷纲/章纲细节、统一风格、增强情节逻辑、修正前后矛盾。\n' +
    '输出润色后的完整大纲（纯文本 Markdown，与输入同格式）。\n\n' +
    `==== 现有全文大纲 ====\n${existing.slice(0, 16000)}`

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  if (!out.trim()) {
    yield { phase: 'error', message: 'LLM 返回空内容' }
    return
  }

  yield { phase: 'write', message: '正在写入润色后大纲…' }
  await knowledgeService.write(novelId, 'outline.md', out, 'ai-refine-outline')
  yield { phase: 'done', message: '全文大纲完善完成' }
}

async function* refineVolumeOutline(
  novelId: string,
  agent: AgentConfig,
  volumeId: string,
  refRange?: { start: number; end: number },
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在收集上下文…' }
  const vols = await collectVolumes(novelId)
  const target = vols.find((v) => v.vol.id === volumeId)
  if (!target) {
    yield { phase: 'error', message: '未找到该卷' }
    return
  }
  const fullOutline = (await knowledgeService.read(novelId, 'outline.md')) ?? ''

  // 可选：附加第 X-Y 卷的卷纲作为参考
  let refVolsText = ''
  if (refRange) {
    const refVols = vols.filter(
      (v) => v.vol.order >= refRange.start && v.vol.order <= refRange.end && v.vol.id !== volumeId,
    )
    if (refVols.length > 0) {
      refVolsText = refVols
        .map((v) => `第${v.vol.order}卷《${v.vol.title}》卷纲：${v.vol.summary || '（暂无）'}`)
        .join('\n')
    }
  }

  yield { phase: 'llm', message: `正在完善第${target.vol.order}卷大纲…` }
  const prompt =
    '你是一名小说大纲润色专家。请基于现有大纲与知识库设定，完善指定卷的卷纲。\n' +
    '要求：补充主线细节、增强情节逻辑、与全书大纲保持一致。\n' +
    '输出纯 JSON：\n{"summary":"完善后的卷纲"}\n\n' +
    `==== 全书大纲 ====\n${fullOutline.slice(0, 8000)}\n\n` +
    `==== 待完善卷：第${target.vol.order}卷《${target.vol.title}》 ====\n现有卷纲：${target.vol.summary || '（暂无）'}\n` +
    (refVolsText ? `\n==== 参考卷纲 ====\n${refVolsText}\n` : '')

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入卷纲…' }
  try {
    const data = JSON.parse(jsonStr) as { summary?: string }
    if (data.summary) {
      await volumeService.update(volumeId, { summary: data.summary })
      await knowledgeService.syncOutline(novelId)
    }
    yield { phase: 'done', message: '卷大纲完善完成' }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}

async function* refineChapterOutline(
  novelId: string,
  agent: AgentConfig,
  chapterId: string,
  refVolRange?: { start: number; end: number },
  refChapRange?: { start: number; end: number },
  signal?: AbortSignal,
): AsyncGenerator<OutlineProgress> {
  yield { phase: 'prepare', message: '正在收集上下文…' }
  const ch = await chapterService.getById(chapterId)
  if (!ch) {
    yield { phase: 'error', message: '未找到该章' }
    return
  }
  const vols = await collectVolumes(novelId)
  const targetVol = vols.find((v) => v.vol.id === ch.volumeId)
  const fullOutline = (await knowledgeService.read(novelId, 'outline.md')) ?? ''
  const content = await chapterService.loadContent(chapterId)

  // 可选：附加第 X-Y 章的章大纲
  let refChapsText = ''
  if (refChapRange) {
    const flat: { ch: Chapter; volOrder: number }[] = vols.flatMap((v) =>
      v.chapters.map((c) => ({ ch: c, volOrder: v.vol.order })),
    )
    // 按 order 排序（章 order 在卷内，跨卷需用卷顺序+章顺序）
    const refChaps = flat.filter(
      (x) => x.ch.order >= refChapRange.start && x.ch.order <= refChapRange.end && x.ch.id !== chapterId,
    )
    if (refChaps.length > 0) {
      refChapsText = refChaps
        .map(
          (x) =>
            `第${x.volOrder}卷第${x.ch.order}章《${x.ch.title}》：${x.ch.summary || '（暂无）'}` +
            (x.ch.hooks?.length ? ` | 细纲: ${x.ch.hooks.join(' / ')}` : ''),
        )
        .join('\n')
    }
  }

  // 可选：附加第 X-Y 卷的卷纲
  let refVolsText = ''
  if (refVolRange) {
    const refVols = vols.filter(
      (v) => v.vol.order >= refVolRange.start && v.vol.order <= refVolRange.end,
    )
    if (refVols.length > 0) {
      refVolsText = refVols
        .map((v) => `第${v.vol.order}卷《${v.vol.title}》：${v.vol.summary || '（暂无）'}`)
        .join('\n')
    }
  }

  yield { phase: 'llm', message: `正在完善第${ch.order}章大纲…` }
  const prompt =
    '你是一名小说大纲润色专家。请基于现有大纲、本章正文与知识库设定，完善指定章的章纲（摘要+细纲）。\n' +
    '要求：补充情节细节、增强节奏感、与卷纲/全书大纲保持一致、承接前文、埋设钩子。\n' +
    '输出纯 JSON：\n{"summary":"完善后的章摘要","hooks":["细纲1","细纲2",...]}\n\n' +
    `==== 全书大纲 ====\n${fullOutline.slice(0, 6000)}\n\n` +
    (targetVol ? `==== 所属卷：第${targetVol.vol.order}卷《${targetVol.vol.title}》 ====\n卷纲：${targetVol.vol.summary || '（暂无）'}\n\n` : '') +
    `==== 待完善章：第${ch.order}章《${ch.title}》 ====\n现有摘要：${ch.summary || '（暂无）'}\n` +
    `现有细纲：${ch.hooks?.length ? ch.hooks.join(' / ') : '（暂无）'}\n\n` +
    (content ? `==== 本章正文节选 ====\n${content.slice(0, 8000)}\n\n` : '') +
    (refChapsText ? `==== 参考章纲 ====\n${refChapsText}\n\n` : '') +
    (refVolsText ? `==== 参考卷纲 ====\n${refVolsText}\n` : '')

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入章纲…' }
  try {
    const data = JSON.parse(jsonStr) as { summary?: string; hooks?: string[] }
    await chapterService.update(chapterId, {
      summary: data.summary || '',
      hooks: Array.isArray(data.hooks) ? data.hooks.map(String) : [],
    })
    await knowledgeService.syncOutline(novelId)
    yield { phase: 'done', message: '章大纲完善完成' }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}
