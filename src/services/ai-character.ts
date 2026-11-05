/**
 * AI 角色提取与构筑服务。
 *
 * extractCharacters：逐章读取正文，LLM 提取出场角色画像，按姓名去重后写入角色表。
 * craftCharacter：从已有内容（知识库+章节）分析，LLM 构筑全新角色（可选性别/角色定位），写入角色表。
 *
 * 架构参照 kb-auto-build.ts：async generator + agentChat，空响应重试 2 次。
 */
import { chapterService, volumeService, characterService, agentConfigService } from './data-service'
import { agentChat } from './agent-service'
import { knowledgeService } from './knowledge-service'
import { indexNovelAssets } from './rag-service'
import type { AgentConfig, Character } from '@shared/types'

export interface CharacterProgress {
  phase: 'prepare' | 'chapter' | 'llm' | 'write' | 'done' | 'error'
  index?: number
  total?: number
  title?: string
  message?: string
}

export interface ExtractOptions {
  signal?: AbortSignal
}

export interface CraftOptions {
  gender?: 'male' | 'female' | 'other'
  role?: 'protagonist' | 'antagonist' | 'supporting' | 'functional'
  signal?: AbortSignal
}

function extractJson(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

async function getAgent(): Promise<AgentConfig | null> {
  const agents = await agentConfigService.getAll()
  if (agents.length === 0) return null
  return agents.find((a) => a.role === 'writer') || agents[0]
}

async function callLLM(agent: AgentConfig, novelId: string, prompt: string, signal?: AbortSignal): Promise<string> {
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

interface ExtractedChar {
  name: string
  role?: string
  gender?: string
  age?: string
  personality?: string
  appearance?: string
  profile?: string
  dynamicState?: string
}

const ROLE_LABELS: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  functional: '功能性',
}

function makeCharacter(novelId: string, c: ExtractedChar, fallbackRole?: string, fallbackGender?: string): Character {
  const now = new Date().toISOString()
  return {
    id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    novelId,
    name: c.name.trim(),
    role: (c.role as Character['role']) || (fallbackRole as Character['role']) || 'supporting',
    gender: (c.gender as Character['gender']) || (fallbackGender as Character['gender']) || 'unknown',
    age: c.age || '',
    personality: c.personality || '',
    appearance: c.appearance || '',
    profile: c.profile || '',
    dynamicState: c.dynamicState || '',
    createdAt: now,
    updatedAt: now,
  }
}

// ===== 角色提取 =====

export async function* extractCharacters(
  novelId: string,
  options: ExtractOptions = {},
): AsyncGenerator<CharacterProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent，请先在设置中添加 Agent 配置' }
    return
  }
  const { signal } = options

  yield { phase: 'prepare', message: '正在收集章节…' }
  const volumes = await volumeService.getByNovelId(novelId)
  const allChapters: { id: string; title: string; order: number; volumeId: string }[] = []
  for (const v of volumes) {
    const chs = await chapterService.getByVolumeId(v.id)
    for (const ch of chs) {
      allChapters.push({ id: ch.id, title: ch.title, order: ch.order, volumeId: v.id })
    }
  }
  if (allChapters.length === 0) {
    yield { phase: 'error', message: '该小说暂无章节，无法提取角色' }
    return
  }

  // 现有角色姓名集合（用于去重）
  const existing = await characterService.getByNovelId(novelId)
  const existingNames = new Set(existing.map((c) => c.name))
  const extracted = new Map<string, ExtractedChar>()
  const total = allChapters.length

  for (let i = 0; i < allChapters.length; i++) {
    const ch = allChapters[i]
    yield { phase: 'chapter', index: i, total, title: ch.title, message: '提取中…' }

    const content = await chapterService.loadContent(ch.id)
    if (!content.trim()) {
      yield { phase: 'chapter', index: i, total, title: ch.title, message: '正文为空，跳过' }
      continue
    }

    const prompt =
      '你是一名小说角色分析师。请阅读以下章节正文，提取出场角色（有名字、有戏份的角色）。\n' +
      '输出纯 JSON（不要 Markdown 代码块）：\n' +
      '{"characters":[{"name":"姓名","role":"protagonist|antagonist|supporting|functional","gender":"male|female|other|unknown","age":"年龄","personality":"性格","appearance":"外貌","profile":"背景档案","dynamicState":"当前动态"}]}\n\n' +
      `==== 第${ch.order}章《${ch.title}》正文 ====\n${content.slice(0, 12000)}`

    const out = await callLLM(agent, novelId, prompt, signal)
    if (signal?.aborted) return
    const jsonStr = extractJson(out)
    if (!jsonStr) {
      yield { phase: 'chapter', index: i, total, title: ch.title, message: '解析失败，跳过' }
      continue
    }

    try {
      const data = JSON.parse(jsonStr) as { characters?: ExtractedChar[] }
      const list = Array.isArray(data.characters) ? data.characters : []
      for (const c of list) {
        if (!c.name || !c.name.trim()) continue
        const name = c.name.trim()
        if (!extracted.has(name)) extracted.set(name, { ...c, name })
      }
      yield { phase: 'chapter', index: i, total, title: ch.title, message: `提取 ${list.length} 个角色` }
    } catch {
      yield { phase: 'chapter', index: i, total, title: ch.title, message: 'JSON 解析失败，跳过' }
    }

    if (i < allChapters.length - 1) await new Promise((r) => setTimeout(r, 1000))
  }

  // 写入新角色（跳过 DB 已有同名角色，避免覆盖手动编辑）
  const newChars = [...extracted.values()].filter((c) => !existingNames.has(c.name))
  if (newChars.length === 0) {
    yield { phase: 'done', message: '未发现新角色（已有角色均已收录）' }
    return
  }

  yield { phase: 'write', message: `正在写入 ${newChars.length} 个新角色…` }
  for (const c of newChars) {
    await characterService.create(makeCharacter(novelId, c))
  }
  await knowledgeService.syncCharacters(novelId)
  await indexNovelAssets(novelId)
  yield { phase: 'done', message: `角色提取完成：新增 ${newChars.length} 个角色` }
}

// ===== 构筑角色 =====

export async function* craftCharacter(
  novelId: string,
  options: CraftOptions = {},
): AsyncGenerator<CharacterProgress> {
  const agent = await getAgent()
  if (!agent) {
    yield { phase: 'error', message: '未找到已配置的 Agent' }
    return
  }
  const { gender, role, signal } = options

  yield { phase: 'llm', message: '正在构筑新角色…' }
  const genderHint = gender
    ? `性别限定：${gender === 'male' ? '男' : gender === 'female' ? '女' : '其他'}。`
    : ''
  const roleHint = role ? `角色定位：${ROLE_LABELS[role] || role}。` : ''
  const prompt =
    '你是一名小说角色构筑师。请基于知识库中的小说资料与已有内容（已在上下文注入），' +
    '构筑一个全新的、与现有角色互补的角色。\n' +
    genderHint + roleHint +
    '要求：角色要有鲜明个性、合理动机、与故事世界契合，且不与已有角色重复。\n' +
    '输出纯 JSON：\n' +
    '{"name":"姓名","role":"protagonist|antagonist|supporting|functional","gender":"male|female|other|unknown","age":"年龄","personality":"性格特点","appearance":"外貌描写","profile":"背景档案/身世","dynamicState":"初始动态"}\n'

  const out = await callLLM(agent, novelId, prompt, signal)
  if (signal?.aborted) return
  const jsonStr = extractJson(out)
  if (!jsonStr) {
    yield { phase: 'error', message: 'LLM 输出无法解析为 JSON' }
    return
  }

  yield { phase: 'write', message: '正在写入角色…' }
  try {
    const c = JSON.parse(jsonStr) as ExtractedChar
    if (!c.name || !c.name.trim()) {
      yield { phase: 'error', message: '角色名为空' }
      return
    }
    const char = makeCharacter(novelId, c, role, gender)
    await characterService.create(char)
    await knowledgeService.syncCharacters(novelId)
    await indexNovelAssets(novelId)
    yield { phase: 'done', message: `角色构筑完成：${char.name}` }
  } catch (e) {
    yield { phase: 'error', message: `写入失败: ${(e as Error).message}` }
  }
}
