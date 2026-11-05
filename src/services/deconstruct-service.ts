// F4 拆书分析服务：把一本完整的书拆成可复用的创作资产。
// 流水线：parseTextFile 切章 → 均匀采样 → 逐章 LLM 拆解（JSON，失败降级）
// → 三次汇总（主线分卷 / 角色世界观简介 / 前三章骨架）→ 报告 + 模板落盘。
// 复用 ai-outline 的 getAgent / callLLM / extractJson。

import type { ChapterSkeleton, MasterPlan, ProposedCharacter, WorldviewCategory } from '@shared/types'
import type { NovelTemplate, TemplateWorldviewEntry } from '@/config/novel-templates'
import { parseTextFile } from './import-service'
import { getAgent, callLLM, extractJson } from './ai-outline'
import { saveUserTemplate } from './template-service'

export interface DeconstructProgress {
  phase: 'parse' | 'analyze' | 'summarize' | 'template' | 'done' | 'error'
  message: string
  chapterIndex?: number
  chapterTotal?: number
}

export interface DeconstructResult {
  reportPath: string
  chaptersPath: string
  templatePath: string
  templateId: string
  sampledChapters: number
  totalChapters: number
}

export interface DeconstructOptions {
  signal?: AbortSignal
  maxChapters?: number
}

const CH_TEXT_LIMIT = 12000

// ===== 采样：首章、中段、末章必含，其余均匀取 =====

export function sampleChapterIndexes(total: number, maxChapters: number): number[] {
  if (total <= maxChapters) return Array.from({ length: total }, (_, i) => i)
  const idx = new Set<number>([0, total - 1, Math.floor(total / 2)])
  const inner = maxChapters - idx.size
  if (inner > 0) {
    const step = total / (inner + 1)
    for (let i = 1; i <= inner; i++) {
      const pos = Math.round(i * step)
      if (pos > 0 && pos < total) idx.add(pos)
    }
  }
  return [...idx].sort((a, b) => a - b)
}

// ===== 逐章拆解 =====

interface ChapterAnalysis {
  scene: string
  characters: { name: string; role: string; profile: string }[]
  beats: string[]
  worldbuilding: string[]
  style: string
}

function fallbackAnalysis(title: string, content: string): ChapterAnalysis {
  const firstPara = content.split(/\n+/).find((p) => p.trim().length > 30) ?? ''
  return { scene: `${title}：${firstPara.slice(0, 80)}`, characters: [], beats: [], worldbuilding: [], style: '' }
}

function buildAnalyzePrompt(title: string, content: string): string {
  return (
    '你是一名小说拆解师。请分析以下章节，输出纯 JSON（不要 Markdown 代码块），格式：\n' +
    '{"scene":"本章场景一句话（谁在哪里干了什么）","characters":[{"name":"角色名","role":"主角/配角/反派","profile":"30字画像"}],"beats":["节拍1","节拍2"],"worldbuilding":["设定点"],"style":"文风一句话（视角/句式/对话密度/情绪）"}\n' +
    'beats 3~6 条；未提及的字段给空值即可。\n\n' +
    `==== 章节标题 ====\n${title}\n==== 章节正文 ====\n${content.slice(0, CH_TEXT_LIMIT)}`
  )
}

function safeParseJson<T>(raw: string): T | null {
  const jsonStr = extractJson(raw)
  if (!jsonStr) return null
  try {
    return JSON.parse(jsonStr) as T
  } catch {
    return null
  }
}

// ===== 拆书主流程 =====

export async function* deconstructBook(
  content: string,
  filename: string,
  options: DeconstructOptions = {},
): AsyncGenerator<DeconstructProgress> {
  const { signal, maxChapters = 30 } = options
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }

  // Phase 1 · 切章与采样
  yield { phase: 'parse', message: '正在切分章节…' }
  const parsed = parseTextFile(content, filename)
  const flat = parsed.volumes.flatMap((v) => v.chapters)
  if (flat.length === 0) {
    yield { phase: 'error', message: '未能从文件中识别出任何章节内容' }
    return
  }
  const sampled = sampleChapterIndexes(flat.length, maxChapters).map((i) => flat[i]).filter(Boolean)
  yield { phase: 'parse', message: `共识别 ${flat.length} 章，采样 ${sampled.length} 章进行分析` }

  // Phase 2 · 逐章拆解
  const analyses: { title: string; wordCount: number }[] = []
  const chapterRecords: Record<string, unknown>[] = []
  for (let i = 0; i < sampled.length; i++) {
    if (signal?.aborted) return
    const ch = sampled[i]
    yield { phase: 'analyze', message: `正在拆解《${ch.title}》`, chapterIndex: i + 1, chapterTotal: sampled.length }
    let analysis: ChapterAnalysis | null = null
    try {
      const raw = await callLLM(agent, '', buildAnalyzePrompt(ch.title, ch.content), signal)
      if (signal?.aborted) return
      analysis = safeParseJson<ChapterAnalysis>(raw)
    } catch {
      analysis = null
    }
    if (!analysis) analysis = fallbackAnalysis(ch.title, ch.content)
    analyses.push({ title: ch.title, wordCount: ch.wordCount })
    chapterRecords.push({ title: ch.title, wordCount: ch.wordCount, analysis })
  }

  // Phase 3 · 三次汇总
  yield { phase: 'summarize', message: '正在汇总全书主线与分卷…' }
  const digest = chapterRecords
    .map((r) => {
      const a = r.analysis as ChapterAnalysis
      return `《${r.title}》：场景=${a.scene}；节拍=${a.beats.join('→') || '无'}；角色=${a.characters.map((c) => c.name).join('、') || '无'}；设定=${a.worldbuilding.join('；') || '无'}；文风=${a.style || '无'}`
    })
    .join('\n')

  const mainPlan = await summarizeMainPlan(agent, digest, signal)
  if (signal?.aborted) return
  yield { phase: 'summarize', message: '正在汇总角色、世界观与简介…' }
  const setting = await summarizeSetting(agent, digest, parsed.characters.map((c) => c.name), signal)
  if (signal?.aborted) return
  yield { phase: 'summarize', message: '正在生成前三章骨架…' }
  const goldenThree = await summarizeGoldenThree(agent, digest, signal)
  if (signal?.aborted) return

  // 组装模板（LLM 输出缺失时降级）
  const template: NovelTemplate = {
    id: `${parsed.title || 'book'}-deconstruct`.replace(/[\\/:*?"<>|\s]+/g, '-'),
    name: `${parsed.title || '未命名'}（拆书）`,
    genres: setting?.genres?.length ? setting.genres : ['未分类'],
    blurb: setting?.blurb || '由拆书分析生成：保留原书的开局节奏与结构设计，情节与角色请替换为你自己的故事。',
    descriptionExample: setting?.description || parsed.description || '',
    characters: normalizeCharacters(setting?.characters, parsed.characters),
    worldviewEntries: normalizeWorldview(setting?.worldview),
    masterPlan: normalizeMasterPlan(mainPlan),
    goldenThree: normalizeGoldenThree(goldenThree),
  }

  // Phase 4 · 报告与模板落盘
  yield { phase: 'template', message: '正在写入拆书报告与模板…' }
  const dateTag = new Date().toISOString().slice(0, 10)
  const safeName = (parsed.title || 'book').replace(/[\\/:*?"<>|\s]+/g, '-')
  const dir = `content/deconstruct/${safeName}-${dateTag}`
  const reportPath = `${dir}/report.md`
  const chaptersPath = `${dir}/chapters.json`
  try {
    await saveUserTemplate(template)
    const report = buildReportMd(parsed.title, template, sampled.length, flat.length, chapterRecords)
    const w = window.electronAPI?.file
    if (w) {
      await w.write(reportPath, report)
      await w.write(chaptersPath, JSON.stringify(chapterRecords, null, 2))
    }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
    return
  }

  yield {
    phase: 'done',
    message: `拆书完成：${sampled.length}/${flat.length} 章已分析，模板「${template.name}」可在新建小说时套用`,
  }
  return {
    reportPath,
    chaptersPath,
    templatePath: `content/templates/${template.id}.json`,
    templateId: template.id,
    sampledChapters: sampled.length,
    totalChapters: flat.length,
  } as DeconstructResult
}

// ===== 三次汇总的 LLM 调用 =====

async function summarizeMainPlan(agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>, digest: string, signal?: AbortSignal) {
  const raw = await callLLM(
    agent,
    '',
    '你是一名小说架构师。以下是对一本书的逐章拆解摘要，请汇总全书主线与分卷规划。输出纯 JSON（不要 Markdown 代码块）：\n' +
      '{"masterOutline":"全书主线（Markdown 纯文本：一段主线概述 + 各卷规划要点）","volumes":[{"title":"卷名","summary":"卷纲（本卷主线/主题/起承转合）"}]}\n' +
      `volumes 2~5 个。\n\n==== 逐章拆解 ====\n${digest.slice(0, 20000)}`,
    signal,
  )
  return safeParseJson<{ masterOutline: string; volumes: { title: string; summary: string }[] }>(raw)
}

async function summarizeSetting(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
  digest: string,
  heuristicNames: string[],
  signal?: AbortSignal,
) {
  const raw = await callLLM(
    agent,
    '',
    '你是一名小说编辑。以下是对一本书的逐章拆解摘要，请汇总角色阵容、世界观条目，并判断题材、重写简介。输出纯 JSON（不要 Markdown 代码块）：\n' +
      '{"genre":"题材","genres":["题材1","题材2"],"blurb":"一句话卖点","description":"150字以内简介","characters":[{"name":"角色名","role":"protagonist|antagonist|supporting 之一","profile":"50字画像"}],"worldview":[{"category":"power|geography|history|cultivation|society|magic|tech|other 之一","title":"条目标题","content":"条目内容"}]}\n' +
      'characters 2~6 个，worldview 2~6 条。\n\n==== 逐章拆解 ====\n' +
      `（频次启发式抽到的人名供参考：${heuristicNames.slice(0, 10).join('、') || '无'}）\n${digest.slice(0, 20000)}`,
    signal,
  )
  return safeParseJson<{
    genre: string
    genres: string[]
    blurb: string
    description: string
    characters: { name: string; role: string; profile: string }[]
    worldview: { category: string; title: string; content: string }[]
  }>(raw)
}

async function summarizeGoldenThree(
  agent: NonNullable<Awaited<ReturnType<typeof getAgent>>>,
  digest: string,
  signal?: AbortSignal,
) {
  const raw = await callLLM(
    agent,
    '',
    '你是一名小说架构师。以下是对一本书的逐章拆解摘要，请提炼前三章骨架：第 1 章立世界、第 2 章立主角、第 3 章立冲突。输出纯 JSON（不要 Markdown 代码块）：\n' +
      '{"chapters":[{"title":"章名","hooks":["细纲要点1","细纲要点2"]}]}\n' +
      'hooks 是前瞻式细纲要点（写「本章要让读者看到什么」，不是回顾式摘要），每章 2~3 条。\n\n' +
      `==== 逐章拆解 ====\n${digest.slice(0, 20000)}`,
    signal,
  )
  return safeParseJson<{ chapters: ChapterSkeleton[] }>(raw)
}

// ===== 归一化（LLM 输出缺失时降级） =====

const ROLES: ProposedCharacter['role'][] = ['protagonist', 'antagonist', 'supporting']
const ROLE_MAP: Record<string, ProposedCharacter['role']> = {
  主角: 'protagonist',
  反派: 'antagonist',
  配角: 'supporting',
}

function normalizeCharacters(llmChars: { name?: string; role?: string; profile?: string }[] | undefined, heuristic: { name: string; role: string; appearances: number }[]): ProposedCharacter[] {
  const out: ProposedCharacter[] = []
  for (const c of llmChars ?? []) {
    if (!c?.name || out.some((p) => p.name === c.name)) continue
    const role = ROLES.find((r) => r === c.role) ?? ROLE_MAP[c.role ?? ''] ?? 'supporting'
    out.push({ name: c.name, role, profile: c.profile || '' })
  }
  // LLM 没给角色时用频次启发式兜底
  for (const h of heuristic) {
    if (out.length >= 6) break
    if (out.some((p) => p.name === h.name)) continue
    out.push({ name: h.name, role: 'supporting', profile: `原书出现约 ${h.appearances} 次` })
  }
  return out.slice(0, 6)
}

const WV_CATEGORIES: WorldviewCategory[] = ['power', 'geography', 'history', 'cultivation', 'society', 'magic', 'tech', 'other']
const WV_MAP: Record<string, WorldviewCategory> = {
  力量体系: 'power',
  力量: 'power',
  修炼: 'cultivation',
  地理: 'geography',
  历史: 'history',
  势力: 'society',
  社会: 'society',
  规则: 'other',
  科技: 'tech',
  魔法: 'magic',
  其他: 'other',
}

function normalizeWorldview(llmWv: { category?: string; title?: string; content?: string }[] | undefined): TemplateWorldviewEntry[] {
  const out: TemplateWorldviewEntry[] = []
  for (const w of llmWv ?? []) {
    if (!w?.title || out.some((p) => p.title === w.title)) continue
    const cat = WV_CATEGORIES.find((c) => c === w.category) ?? WV_MAP[w.category ?? ''] ?? 'other'
    out.push({ category: cat, title: w.title, content: w.content || '' })
    if (out.length >= 6) break
  }
  return out
}

function normalizeMasterPlan(main: { masterOutline: string; volumes: { title: string; summary: string }[] } | null): MasterPlan {
  const vols = (main?.volumes ?? []).slice(0, 5).map((v, i) => ({
    title: v.title || `第${i + 1}卷`,
    summary: v.summary || '',
  }))
  return {
    masterOutline: main?.masterOutline || '',
    volumes: vols.length > 0 ? vols : [{ title: '第一卷', summary: main?.masterOutline || '待规划' }],
  }
}

function normalizeGoldenThree(g: { chapters: ChapterSkeleton[] } | null): ChapterSkeleton[] {
  const chs = g?.chapters ?? []
  const out: ChapterSkeleton[] = []
  for (let i = 0; i < 3; i++) {
    const c = chs[i]
    out.push({
      title: c?.title || `第${i + 1}章`,
      hooks: Array.isArray(c?.hooks) ? c.hooks.map(String).slice(0, 3) : [],
    })
  }
  return out
}

// ===== 报告生成 =====

function buildReportMd(
  title: string,
  template: NovelTemplate,
  sampled: number,
  total: number,
  chapterRecords: Record<string, unknown>[],
): string {
  const lines: string[] = []
  lines.push(`# 拆书报告：${title}`)
  lines.push('')
  lines.push(`> 采样 ${sampled} / ${total} 章分析。本报告是「参照物」不是「抄袭稿」：可借鉴的是结构、节奏、钩子设计，具体情节文字请替换为你自己的故事。`)
  lines.push('')
  lines.push('## 题材与简介')
  lines.push('')
  lines.push(`- 题材：${template.genres.join('、')}`)
  lines.push(`- 卖点：${template.blurb}`)
  lines.push(`- 简介示例：${template.descriptionExample}`)
  lines.push('')
  lines.push('## 主线与分卷')
  lines.push('')
  lines.push(template.masterPlan.masterOutline || '（未提炼）')
  lines.push('')
  template.masterPlan.volumes.forEach((v, i) => {
    lines.push(`### 第${i + 1}卷《${v.title}》`)
    lines.push(v.summary)
    lines.push('')
  })
  lines.push('## 角色阵容')
  lines.push('')
  template.characters.forEach((c) => lines.push(`- **${c.name}**（${c.role}）：${c.profile}`))
  lines.push('')
  lines.push('## 世界观条目')
  lines.push('')
  template.worldviewEntries.forEach((w) => lines.push(`- **${w.title}**（${w.category}）：${w.content}`))
  lines.push('')
  lines.push('## 前三章骨架')
  lines.push('')
  template.goldenThree.forEach((c, i) => {
    lines.push(`### 第${i + 1}章《${c.title}》`)
    c.hooks.forEach((h) => lines.push(`- 钩子：${h}`))
    lines.push('')
  })
  lines.push('## 逐章采样明细')
  lines.push('')
  chapterRecords.forEach((r) => {
    const a = r.analysis as ChapterAnalysis
    lines.push(`- 《${r.title}》（约 ${r.wordCount} 字）：${a.scene}`)
  })
  lines.push('')
  return lines.join('\n')
}
