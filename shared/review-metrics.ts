// P3 读者模拟的确定性核心（纯函数）：钩子强度、信息密度、情绪曲线、弃读点与可执行建议。
// 规则版结果必须独立可用；模型只做补充，不覆盖这里的数值。
import type { ReaderDropOff, ReaderPayoff } from './review-types'
import { computeStyleMetrics } from './style-metrics'

const EMOTION_CUE = /(怒|恨|怕|慌|惊|痛|哭|笑|喜|悲|急|颤|咬牙|冷笑|沉默|窒息|心跳|呼吸|冷汗|发烫|发凉|酸|涩|暖|冷|崩|嘿|吼|骂)/g
const HOOK_CUE = /(却|竟|原来|但是|可是|忽然|突然|竟然|没想到|不料|谁知|偏偏|秘密|倒计时|来不及|只剩|最后一个)/g
const DIALOGUE = /[“”"「」]/
const STOP_WORDS = new Set([
  '是否', '如何', '什么', '怎么', '为什么', '一个', '这个', '那个', '他们', '她们',
  '我们', '你们', '自己', '之后', '之前', '已经', '将要', '还是', '就是', '不是',
])

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

function round(n: number): number {
  return Math.round(n)
}

function countCues(text: string, re: RegExp): number {
  return (text.match(re) || []).length
}

function paragraphsWithLines(content: string): { text: string; line: number; start: number }[] {
  const out: { text: string; line: number; start: number }[] = []
  const lines = content.split(/\r?\n/)
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim()
    if (text) out.push({ text, line: i + 1, start: offset })
    offset += lines[i].length + 1
  }
  return out
}

/** 把正文按字符等分成五段，统计每段的情绪词密度（每千字 × 6，封顶 100）。 */
export function computeEmotionCurve(content: string): number[] {
  const text = content.replace(/\s/g, '')
  if (!text) return [0, 0, 0, 0, 0]
  const size = Math.ceil(text.length / 5)
  const curve: number[] = []
  for (let i = 0; i < 5; i++) {
    const segment = text.slice(i * size, (i + 1) * size)
    if (!segment.length) {
      curve.push(0)
      continue
    }
    const per1k = (countCues(segment, EMOTION_CUE) / segment.length) * 1000
    curve.push(clamp(round(per1k * 6), 0, 100))
  }
  return curve
}

export function computeHookStrength(content: string): { score: number; chapterEndHook: boolean } {
  const metrics = computeStyleMetrics(content)
  const trimmed = content.trim()
  if (!trimmed) return { score: 0, chapterEndHook: false }

  const lastSlice = trimmed.slice(-200)
  const lastParagraph = trimmed.split(/\r?\n/).map((p) => p.trim()).filter(Boolean).pop() ?? ''
  const lastSentence = lastParagraph.split(/[。！？!?…\n]/).map((s) => s.trim()).filter(Boolean).pop() ?? ''
  const tail = trimmed.slice(Math.max(0, Math.floor(trimmed.length * 0.8)))
  const chapterEndHook =
    metrics.hookEnding || (HOOK_CUE.test(lastSlice) && /[。！？!?…]$/.test(lastParagraph))

  let score = 0
  if (metrics.hookEnding) score += 40
  if (HOOK_CUE.test(lastSlice)) score += 20
  if (lastSentence.length > 0 && lastSentence.length <= 30) score += 15
  else if (lastSentence.length <= 60) score += 8
  if (DIALOGUE.test(tail)) score += 10
  score += Math.min(15, round(metrics.infoHookPer1k * 2.5))
  return { score: clamp(score, 0, 100), chapterEndHook }
}

export function computeInfoDensity(content: string): number {
  const metrics = computeStyleMetrics(content)
  if (!metrics.chars) return 0
  const paragraphs = paragraphsWithLines(content)
  const paragraphsPer1k = paragraphs.length / Math.max(1, metrics.chars / 1000)
  const longParagraphs = paragraphs.filter((p) => p.text.length > 280).length
  const longShare = longParagraphs / Math.max(1, paragraphs.length)
  const score =
    40 * clamp(paragraphsPer1k / 6, 0, 1) +
    30 * clamp(metrics.dialoguePct / 30, 0, 1) +
    30 * (1 - longShare)
  return clamp(round(score), 0, 100)
}

export function findDropOffs(content: string): ReaderDropOff[] {
  const paragraphs = paragraphsWithLines(content)
  const total = paragraphs.length
  const out: ReaderDropOff[] = []
  for (const p of paragraphs) {
    if (p.text.length < 280) continue
    const hasDialogue = DIALOGUE.test(p.text)
    const emotions = countCues(p.text, EMOTION_CUE)
    if (!hasDialogue) {
      out.push({
        location: `第 ${p.line} 行`,
        reason: `连续 ${p.text.length} 字叙述，期间没有对话`,
        suggestion: '把这段拆成 2~3 段，至少插入一句对话或一个动作反应。',
      })
    } else if (p.text.length >= 450) {
      out.push({
        location: `第 ${p.line} 行`,
        reason: `长段 ${p.text.length} 字，信息堆叠且情绪变化只有 ${emotions} 处`,
        suggestion: '保留一个核心信息，其余拆到后文；在段中安排一次打断或追问。',
      })
    }
    if (out.length >= 3) break
  }
  return out
}

function hookTokens(hook: string): string[] {
  return hook
    .split(/[，。！？、；：\s“”"'「」（）()《》]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !STOP_WORDS.has(s))
    .slice(0, 6)
}

/** 用细纲 hooks 的关键词在正文中的出现比例，粗判期待兑现程度。 */
export function computePayoffs(content: string, hooks: string[]): ReaderPayoff[] {
  const body = content.replace(/\s/g, '')
  return hooks
    .filter((h) => h.trim())
    .slice(0, 4)
    .map((hook) => {
      const tokens = hookTokens(hook)
      const matched = tokens.filter((t) => body.includes(t.replace(/\s/g, ''))).length
      const ratio = tokens.length ? matched / tokens.length : 0
      const status: ReaderPayoff['status'] = ratio >= 0.6 ? 'paid' : ratio >= 0.3 ? 'partial' : 'unpaid'
      const note =
        status === 'paid'
          ? '正文已覆盖该期待点，确认读者能明确看出兑现。'
          : status === 'partial'
            ? '正文只覆盖了部分关键词，建议把兑现写成可见结果。'
            : '正文没有明确覆盖，若本章不是故意延后，建议补一个部分回收。'
      return { expectation: hook.trim(), status, note }
    })
}

export interface ReaderMetrics {
  wordCount: number
  dialoguePct: number
  hookStrength: number
  chapterEndHook: boolean
  infoDensity: number
  emotionCurve: number[]
  dropOffs: ReaderDropOff[]
  payoffs: ReaderPayoff[]
  suggestions: string[]
}

export function computeReaderMetrics(content: string, hooks: string[] = []): ReaderMetrics {
  const style = computeStyleMetrics(content)
  const hook = computeHookStrength(content)
  const infoDensity = computeInfoDensity(content)
  const emotionCurve = computeEmotionCurve(content)
  const dropOffs = findDropOffs(content)
  const payoffs = computePayoffs(content, hooks)

  const maxEmotion = Math.max(...emotionCurve)
  const minEmotion = Math.min(...emotionCurve)
  const flat = maxEmotion - minEmotion < 20

  const suggestions: string[] = []
  if (hook.score < 60) {
    suggestions.push(
      `章末钩子偏弱（${hook.score}/100）：把最后 3 行改成新问题、新决定或反转，不要用总结句收尾。`
    )
  }
  if (infoDensity > 75) {
    suggestions.push(
      `本章信息密度偏高（${infoDensity}/100）：把世界观或前情说明拆到后续章节，先写清当前场景的冲突。`
    )
  } else if (infoDensity < 35 && style.chars > 200) {
    suggestions.push(
      `本章信息密度偏低（${infoDensity}/100）：补一个具体目标、代价或倒计时，避免读者觉得没有推进。`
    )
  }
  if (flat && style.chars > 300) {
    suggestions.push(
      `情绪曲线偏平（最高 ${maxEmotion}、最低 ${minEmotion}）：在中段安排一次冲突升级或代价揭示。`
    )
  }
  if (style.dialoguePct < 8 && style.chars > 300) {
    suggestions.push(
      `对话占比只有 ${style.dialoguePct.toFixed(1)}%：连续叙述偏长，建议插入 2~3 句来回对话换气。`
    )
  }
  for (const d of dropOffs.slice(0, 2)) {
    suggestions.push(`${d.location}：${d.suggestion}`)
  }
  const unpaid = payoffs.filter((p) => p.status === 'unpaid')
  if (unpaid.length) {
    suggestions.push(`细纲期待「${unpaid[0].expectation}」在本章没有兑现：补一个部分回收或明确延后。`)
  }
  if (suggestions.length < 3) {
    suggestions.push('给本章主角设置一个当章必须解决的小目标，让章末状态与开篇不同。')
  }
  if (suggestions.length < 3) {
    suggestions.push('把章末最后一句改成短句，并在下一段开头立刻给反应。')
  }
  if (suggestions.length < 3) {
    suggestions.push('检查本章有没有新信息推动主线；没有的话，用一次选择或冲突补上推进。')
  }

  return {
    wordCount: style.chars,
    dialoguePct: style.dialoguePct,
    hookStrength: hook.score,
    chapterEndHook: hook.chapterEndHook,
    infoDensity,
    emotionCurve,
    dropOffs,
    payoffs,
    suggestions: [...new Set(suggestions)].slice(0, 6),
  }
}

/** 规则版读者可能带走的问题；模型可用时由模型替换。 */
export function deterministicQuestions(hooks: string[], chapterEndHook: boolean): string[] {
  const questions = hooks
    .filter((h) => h.trim())
    .slice(0, 3)
    .map((h) => `“${h.trim()}”会怎么落地？`)
  if (!chapterEndHook) {
    questions.push('主角下一步要做什么？章末没有给出明确方向。')
  }
  if (!questions.length) {
    questions.push('这一章改变了主角的什么处境？')
    questions.push('下一章读者最想看到哪个问题被回答？')
  }
  return [...new Set(questions)].slice(0, 3)
}
