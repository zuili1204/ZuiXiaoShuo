/**
 * P3 读者模拟（规划 §11.2）。
 *
 * 输入：读者画像（题材/平台/性别向）+ 单章或前 3 章 + 章末钩子。
 * 输出：可能带走的问题、期待兑现点、弃读点、钩子强度、信息密度、情绪曲线。
 *
 * 约束：所有结论都标注“模拟，不是真实数据”；只给可执行建议，不预测爆款；
 * 规则指标始终可用，模型只补充质性判断，不覆盖确定性数值。
 */
import type { Chapter } from '@shared/types'
import {
  DEFAULT_READER_PROFILE,
  type ReaderDropOff,
  type ReaderPayoff,
  type ReaderProfile,
  type ReaderSimResult,
  type ReaderSimRun,
} from '@shared/review-types'
import { computeReaderMetrics, deterministicQuestions } from '@shared/review-metrics'
import { getAgent, callLLM, extractJson } from './ai-outline'
import { getSetting, setSetting } from './settings-service'

const api = () => window.electronAPI

const PROFILE_KEY = (novelId: string) => `review.reader.profile.${novelId}`

const GENDER_VALUES: ReaderProfile['genderOrientation'][] = ['male', 'female', 'general', 'unspecified']

export async function loadReaderProfile(novelId: string): Promise<ReaderProfile> {
  try {
    const raw = await getSetting<string>(PROFILE_KEY(novelId), '')
    if (!raw) return { ...DEFAULT_READER_PROFILE }
    const parsed = JSON.parse(raw) as Partial<ReaderProfile>
    return {
      genre: typeof parsed.genre === 'string' ? parsed.genre.slice(0, 40) : '',
      platform: typeof parsed.platform === 'string' ? parsed.platform.slice(0, 40) : '',
      genderOrientation: GENDER_VALUES.includes(parsed.genderOrientation as any)
        ? (parsed.genderOrientation as ReaderProfile['genderOrientation'])
        : 'unspecified',
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 120) : '',
    }
  } catch {
    return { ...DEFAULT_READER_PROFILE }
  }
}

export async function saveReaderProfile(novelId: string, profile: ReaderProfile): Promise<void> {
  await setSetting(PROFILE_KEY(novelId), JSON.stringify(profile))
}

function clamp(n: number, min = 0, max = 100): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

function profileLabel(p: ReaderProfile): string {
  const gender =
    p.genderOrientation === 'male' ? '男性向'
      : p.genderOrientation === 'female' ? '女性向'
        : p.genderOrientation === 'general' ? '大众向'
          : '性别向未指定'
  return [p.genre || '题材未指定', p.platform || '平台未指定', gender, p.note].filter(Boolean).join('；')
}

function splitPayoffStatus(v: unknown): ReaderPayoff['status'] {
  return v === 'paid' || v === 'partial' || v === 'unpaid' ? v : 'unpaid'
}

interface ReaderSimJson {
  questions?: unknown
  payoffs?: unknown
  dropOffs?: unknown
  hookStrength?: unknown
  infoDensity?: unknown
  emotionCurve?: unknown
  suggestions?: unknown
  notes?: unknown
}

const READER_PROMPT = (
  profile: ReaderProfile,
  content: string,
  hooks: string[]
) => `你是一名“模拟读者”，不是真实用户，也不能预测作品成败。请从目标读者视角阅读下面的章节，指出可能影响继续阅读的具体位置。

【目标读者】
${profileLabel(profile)}

【本章细纲】
${hooks.length ? hooks.map((h) => `- ${h}`).join('\n') : '（未设置）'}

【正文（可能包含前情章节）】
${content.slice(0, 12000)}

只返回 JSON（不要解释）：
{
  "questions": ["读者读完可能带走的问题，最多 3 条"],
  "payoffs": [{"expectation":"期待的兑现点","status":"paid|partial|unpaid","note":"不超过 40 字"}],
  "dropOffs": [{"location":"第 N 行或某段","reason":"为什么可能弃读","suggestion":"可执行的修改动作"}],
  "hookStrength": 0-100,
  "infoDensity": 0-100,
  "emotionCurve": [0-100, 0-100, 0-100, 0-100, 0-100],
  "suggestions": ["至少 3 条可执行建议，写清改哪一段、怎么改"],
  "notes": "不超过 80 字，明确这是模拟判断"
}

要求：不要给“必爆/必扑”结论；不要编造读者数据；没有把握就少写。`

async function runModelSimulation(
  novelId: string,
  profile: ReaderProfile,
  content: string,
  hooks: string[],
  signal?: AbortSignal
): Promise<ReaderSimJson | null> {
  try {
    const agent = await getAgent()
    if (!agent) return null
    const raw = await callLLM(agent, novelId, READER_PROMPT(profile, content, hooks), signal)
    const json = extractJson(raw)
    if (!json) return null
    return JSON.parse(json) as ReaderSimJson
  } catch (e) {
    console.warn('[reader-sim] model simulation failed:', e)
    return null
  }
}

export interface ReaderSimOptions {
  novelId: string
  chapter: Chapter
  content: string
  /** 前文章节（按顺序），用于“前 3 章”模拟；正文拼接后交给模型 */
  previous?: { title: string; content: string }[]
  profile: ReaderProfile
  useModel?: boolean
  signal?: AbortSignal
}

export async function simulateReader(options: ReaderSimOptions): Promise<ReaderSimResult> {
  const { novelId, chapter, content, profile } = options
  const hooks = chapter.hooks ?? []
  const metrics = computeReaderMetrics(content, hooks)
  const previous = (options.previous ?? []).filter((p) => p.content.trim())
  const chapterCount = previous.length + 1

  const combined = [
    ...previous.map((p) => `【${p.title}】\n${p.content}`),
    `【${chapter.title}】\n${content}`,
  ].join('\n\n')

  const json = options.useModel
    ? await runModelSimulation(novelId, profile, combined, hooks, options.signal)
    : null

  const modelQuestions = Array.isArray(json?.questions)
    ? json!.questions.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 3)
    : []
  const questions = modelQuestions.length
    ? modelQuestions
    : deterministicQuestions(hooks, metrics.chapterEndHook)

  const modelPayoffs: ReaderPayoff[] = Array.isArray(json?.payoffs)
    ? (json!.payoffs as any[])
        .filter((p) => p && typeof p.expectation === 'string' && p.expectation.trim())
        .slice(0, 4)
        .map((p) => ({
          expectation: String(p.expectation).slice(0, 80),
          status: splitPayoffStatus(p.status),
          note: typeof p.note === 'string' ? p.note.slice(0, 80) : '',
        }))
    : []
  const payoffs = modelPayoffs.length ? modelPayoffs : metrics.payoffs

  const modelDropOffs: ReaderDropOff[] = Array.isArray(json?.dropOffs)
    ? (json!.dropOffs as any[])
        .filter((d) => d && typeof d.reason === 'string' && d.reason.trim())
        .slice(0, 3)
        .map((d) => ({
          location: typeof d.location === 'string' ? d.location.slice(0, 40) : '未定位',
          reason: String(d.reason).slice(0, 100),
          suggestion: typeof d.suggestion === 'string' ? d.suggestion.slice(0, 120) : '把这一段缩短并加入冲突。',
        }))
    : []
  const dropOffs = modelDropOffs.length ? modelDropOffs : metrics.dropOffs

  const modelHook = Number(json?.hookStrength)
  const modelDensity = Number(json?.infoDensity)
  const hookStrength = Number.isFinite(modelHook) ? clamp(modelHook) : metrics.hookStrength
  const infoDensity = Number.isFinite(modelDensity) ? clamp(modelDensity) : metrics.infoDensity
  const modelCurve =
    Array.isArray(json?.emotionCurve) && json!.emotionCurve.length === 5
      ? json!.emotionCurve.map((n) => clamp(Number(n)))
      : null
  const emotionCurve = modelCurve ?? metrics.emotionCurve

  const modelSuggestions = Array.isArray(json?.suggestions)
    ? json!.suggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 4)
    : []
  const suggestions = [...new Set([...metrics.suggestions, ...modelSuggestions])].slice(0, 6)

  const notes = typeof json?.notes === 'string' && json.notes.trim()
    ? json.notes.slice(0, 200)
    : '基于文本规则与目标读者画像的模拟，不代表真实读者数据。'

  return {
    simulated: true,
    modelAssisted: !!json,
    questions,
    payoffs,
    dropOffs,
    hookStrength,
    infoDensity,
    emotionCurve,
    suggestions,
    notes,
    chapterCount,
    createdAt: new Date().toISOString(),
  }
}

// ===== 前文章节 =====

export async function listPreviousChapterContents(
  novelId: string,
  currentChapterId: string,
  maxPrevious = 2
): Promise<{ id: string; title: string; content: string }[]> {
  try {
    const rows = (await api().db.query(
      `SELECT c.id, c.title, c.content_path
       FROM chapters c JOIN volumes v ON v.id = c.volume_id
       WHERE v.novel_id = ?
       ORDER BY v.order_num ASC, c.order_num ASC`,
      [novelId]
    )) as { id: string; title: string; content_path: string }[]
    const index = rows.findIndex((r) => r.id === currentChapterId)
    if (index <= 0) return []
    const slice = rows.slice(Math.max(0, index - maxPrevious), index)
    const out: { id: string; title: string; content: string }[] = []
    for (const r of slice) {
      if (!r.content_path) continue
      try {
        const content = await api().file.read(r.content_path)
        if (content.trim()) out.push({ id: r.id, title: r.title, content })
      } catch {
        // 缺文件时跳过，不阻断模拟
      }
    }
    return out
  } catch (e) {
    console.error('[reader-sim] list previous chapters failed:', e)
    return []
  }
}

// ===== 落库 =====

export async function saveReaderSimRun(input: {
  novelId: string
  chapterIds: string[]
  profile: ReaderProfile
  result: ReaderSimResult
  modelName?: string
}): Promise<ReaderSimRun> {
  const run: ReaderSimRun = {
    ...input.result,
    id: `rsr_${crypto.randomUUID()}`,
    novelId: input.novelId,
    chapterIds: input.chapterIds,
    profile: input.profile,
    model: input.modelName ?? '',
  }
  await api().db.query(
    `INSERT INTO reader_sim_runs
      (id, novel_id, chapter_ids_json, profile_json, result_json, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      run.id,
      input.novelId,
      JSON.stringify(run.chapterIds),
      JSON.stringify(run.profile),
      JSON.stringify(run),
      run.model,
      run.createdAt,
    ]
  )
  return run
}

function rowToReaderRun(row: any): ReaderSimRun {
  let result: Partial<ReaderSimRun> = {}
  try {
    result = JSON.parse(row.result_json || '{}')
  } catch {
    result = {}
  }
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterIds: safeArray(row.chapter_ids_json),
    profile: safeProfile(row.profile_json),
    simulated: true,
    modelAssisted: !!result.modelAssisted,
    questions: Array.isArray(result.questions) ? result.questions : [],
    payoffs: Array.isArray(result.payoffs) ? result.payoffs : [],
    dropOffs: Array.isArray(result.dropOffs) ? result.dropOffs : [],
    hookStrength: Number(result.hookStrength) || 0,
    infoDensity: Number(result.infoDensity) || 0,
    emotionCurve: Array.isArray(result.emotionCurve) ? result.emotionCurve.map(Number) : [0, 0, 0, 0, 0],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    notes: typeof result.notes === 'string' ? result.notes : '',
    chapterCount: Number(result.chapterCount) || 1,
    createdAt: row.created_at,
    model: row.model ?? '',
  }
}

function safeArray(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function safeProfile(raw: unknown): ReaderProfile {
  try {
    const parsed = JSON.parse(String(raw ?? '{}')) as Partial<ReaderProfile>
    return {
      genre: typeof parsed.genre === 'string' ? parsed.genre : '',
      platform: typeof parsed.platform === 'string' ? parsed.platform : '',
      genderOrientation: GENDER_VALUES.includes(parsed.genderOrientation as any)
        ? (parsed.genderOrientation as ReaderProfile['genderOrientation'])
        : 'unspecified',
      note: typeof parsed.note === 'string' ? parsed.note : '',
    }
  } catch {
    return { ...DEFAULT_READER_PROFILE }
  }
}

export async function listReaderSimRuns(novelId: string, limit = 10): Promise<ReaderSimRun[]> {
  try {
    const rows = (await api().db.query(
      'SELECT * FROM reader_sim_runs WHERE novel_id = ? ORDER BY created_at DESC LIMIT ?',
      [novelId, limit]
    )) as any[]
    return rows.map(rowToReaderRun)
  } catch (e) {
    console.error('[reader-sim] list runs failed:', e)
    return []
  }
}
