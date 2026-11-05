/**
 * P1 确定性连贯性检查器（纯函数）。
 *
 * 输入 = 正文 + 角色状态快照 + 时间线事件 + 剧情线 + 场景卡；
 * 输出 = Finding[]。LLM 语义检查只作为后续补充，不覆盖这里的结论。
 * 规则说明见 docs/写作系统统一规划 §8.4。
 */
import type {
  CharacterState,
  PlotThread,
  SceneCard,
  TimelineEvent,
} from '@shared/types'
import {
  computeThreadRisks,
  latestCharacterStates,
  type ThreadRisk,
} from './story-state-service'

export type ContinuitySeverity = 'blocking' | 'warning'

export type ContinuityRuleId =
  | 'dead-character'
  | 'dual-location'
  | 'item-early'
  | 'ability-early'
  | 'time-reversal'
  | 'foreshadow-order'
  | 'main-overdue'
  | 'thread-stale'
  | 'name-inconsistent'
  | 'promise-unfulfilled'
  | 'hooks-uncovered'

export interface ContinuityFinding {
  ruleId: ContinuityRuleId
  severity: ContinuitySeverity
  message: string
  location?: string
  suggestion?: string
  evidence?: string
}

export interface ContinuityRuleMeta {
  id: ContinuityRuleId
  label: string
  severity: ContinuitySeverity
}

export const CONTINUITY_RULES: ContinuityRuleMeta[] = [
  { id: 'dead-character', label: '死者出场', severity: 'blocking' },
  { id: 'item-early', label: '物品提前', severity: 'blocking' },
  { id: 'ability-early', label: '能力提前', severity: 'blocking' },
  { id: 'time-reversal', label: '时间倒流', severity: 'blocking' },
  { id: 'dual-location', label: '同刻两地', severity: 'warning' },
  { id: 'foreshadow-order', label: '伏笔错序', severity: 'warning' },
  { id: 'main-overdue', label: '主线逾期', severity: 'warning' },
  { id: 'thread-stale', label: '伏笔老化', severity: 'warning' },
  { id: 'name-inconsistent', label: '名称不一致', severity: 'warning' },
  { id: 'promise-unfulfilled', label: '承诺未兑现', severity: 'warning' },
  { id: 'hooks-uncovered', label: '细纲未覆盖', severity: 'warning' },
]

export interface ContinuityCheckInput {
  /** 当前章序（1 起）；用于判断“未来物品/能力”和章节截止。 */
  chapterOrder: number
  content: string
  characterStates: CharacterState[]
  timelineEvents?: TimelineEvent[]
  plotThreads?: PlotThread[]
  sceneCards?: SceneCard[]
  /** 本章细纲 hooks（未制定时为空数组）。 */
  hooks?: string[]
  /** 上一章留下的“下一章承诺”。 */
  previousPromises?: string[]
  /** 全书角色名，用于名称一致性检查。 */
  characterNames?: string[]
  /** characterId → 名称，用于死者出场定位。 */
  characterNamesById?: Record<string, string>
  /** 老化阈值（章），默认 20。 */
  staleAfter?: number
}

export interface ContinuityReport {
  findings: ContinuityFinding[]
  blocking: number
  warnings: number
}

// ===== 工具 =====

const CJK_PUNCT = /[\s，。！？、；：“”‘’"'（）()《》【】…—·,.!?;:\-]/g

function normalizeName(name: string): string {
  return name.replace(CJK_PUNCT, '')
}

function evidenceAround(content: string, needle: string, radius = 12): string {
  const idx = content.indexOf(needle)
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + needle.length + radius)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

type TimeValue = { unit: 'day' | 'date' | 'clock'; value: number }

/** 解析常见故事时间写法；无法解析返回 null（不猜）。 */
export function parseStoryTime(raw: string): TimeValue | null {
  if (!raw) return null
  const t = raw.trim()

  const day = t.match(/^第\s*(\d+)\s*天/)
  if (day) return { unit: 'day', value: Number(day[1]) }

  const cn = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?/)
  if (cn) {
    const [, y, mo, d, h = '0', mi = '0'] = cn
    return {
      unit: 'date',
      value: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) / 1000,
    }
  }

  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0'] = iso
    return {
      unit: 'date',
      value: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) / 1000,
    }
  }

  const md = t.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (md) {
    return {
      unit: 'date',
      value: Date.UTC(2000, Number(md[1]) - 1, Number(md[2])) / 1000,
    }
  }

  const clock = t.match(/^(\d{1,2})[:：](\d{2})$/)
  if (clock) return { unit: 'clock', value: Number(clock[1]) * 60 + Number(clock[2]) }

  return null
}

// ===== 规则 =====

function checkDeadCharacters(
  input: ContinuityCheckInput,
  latest: CharacterState[]
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  for (const s of latest) {
    if (s.status !== 'dead') continue
    // 死亡当章不算违规（可能是刚写死）
    if (s.chapterOrder >= input.chapterOrder) continue
    const name = input.characterNamesById?.[s.characterId]
    if (!name || !input.content.includes(name)) continue
    findings.push({
      ruleId: 'dead-character',
      severity: 'blocking',
      message: `角色「${name}」已在第${s.chapterOrder}章死亡，本章仍有出场`,
      location: `第${input.chapterOrder}章`,
      suggestion: '确认是否为回忆/幻象并明确标注，否则删除该角色出场',
      evidence: evidenceAround(input.content, name),
    })
  }
  return findings
}

function checkEarlyItemsAndAbilities(
  input: ContinuityCheckInput,
  latest: CharacterState[]
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  for (const s of latest) {
    for (const item of s.items) {
      if (item.acquiredChapter == null || item.acquiredChapter <= input.chapterOrder) continue
      if (!input.content.includes(item.name)) continue
      findings.push({
        ruleId: 'item-early',
        severity: 'blocking',
        message: `物品「${item.name}」计划第${item.acquiredChapter}章获得，本章已在使用`,
        location: `第${input.chapterOrder}章`,
        suggestion: '调整获得章节，或本章改为尚未持有',
        evidence: evidenceAround(input.content, item.name),
      })
    }
    for (const ability of s.abilities) {
      if (ability.unlockedChapter == null || ability.unlockedChapter <= input.chapterOrder) continue
      if (!input.content.includes(ability.name)) continue
      findings.push({
        ruleId: 'ability-early',
        severity: 'blocking',
        message: `能力「${ability.name}」计划第${ability.unlockedChapter}章解锁，本章已在使用`,
        location: `第${input.chapterOrder}章`,
        suggestion: '提前解锁需要在前文补写获得过程',
        evidence: evidenceAround(input.content, ability.name),
      })
    }
  }
  return findings
}

function checkTimeReversal(input: ContinuityCheckInput): ContinuityFinding[] {
  const events = input.timelineEvents
  if (!events?.length) return []
  const current = events.filter((e) => e.chapterOrder === input.chapterOrder)
  if (!current.length) return []
  const previous = events.filter((e) => e.chapterOrder < input.chapterOrder)
  if (!previous.length) return []

  const findings: ContinuityFinding[] = []
  for (const cur of current) {
    const curTime = parseStoryTime(cur.storyTime)
    if (!curTime) continue
    const sameUnit = previous
      .map((e) => ({ e, t: parseStoryTime(e.storyTime) }))
      .filter((x): x is { e: TimelineEvent; t: TimeValue } => !!x.t && x.t.unit === curTime.unit)
    if (!sameUnit.length) continue
    const latestPrev = sameUnit.reduce((a, b) => (b.t.value > a.t.value ? b : a))
    if (curTime.value < latestPrev.t.value) {
      findings.push({
        ruleId: 'time-reversal',
        severity: 'blocking',
        message: `本章时间「${cur.storyTime}」早于第${latestPrev.e.chapterOrder}章的「${latestPrev.e.storyTime}」`,
        location: `第${input.chapterOrder}章 · ${cur.event}`,
        suggestion: '确认是否为插叙；若是，请标注回忆并移出主时间线',
        evidence: cur.event,
      })
    }
  }
  return findings
}

function checkDualLocation(input: ContinuityCheckInput): ContinuityFinding[] {
  const events = input.timelineEvents
  if (!events?.length) return []
  const byTime = new Map<string, TimelineEvent[]>()
  for (const e of events) {
    if (!e.storyTime?.trim() || !e.location?.trim() || !e.characters.length) continue
    const key = e.storyTime.replace(/\s+/g, '')
    const list = byTime.get(key) ?? []
    list.push(e)
    byTime.set(key, list)
  }

  const findings: ContinuityFinding[] = []
  for (const [time, list] of byTime) {
    // 只检查与当前章节相关的同刻事件，避免历史冲突在每次保存时重复告警
    if (!list.some((e) => e.chapterOrder === input.chapterOrder)) continue
    const places = new Map<string, Set<string>>()
    for (const e of list) {
      for (const c of e.characters) {
        const set = places.get(c) ?? new Set<string>()
        set.add(e.location)
        places.set(c, set)
      }
    }
    for (const [character, set] of places) {
      if (set.size < 2) continue
      findings.push({
        ruleId: 'dual-location',
        severity: 'warning',
        message: `「${character}」在「${time}」同时出现在 ${Array.from(set).join(' / ')}`,
        location: `时间 ${time}`,
        suggestion: '拆分时间点或确认其中一个事件的地点出错',
      })
      break // 同一时间点只报一次角色冲突
    }
  }
  return findings
}

function checkThreads(input: ContinuityCheckInput, risks: ThreadRisk[]): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  for (const r of risks) {
    // 文档约定：主线逾期只作 warning，但消息明确标注主线
    const id = r.thread.kind === 'main' ? 'main-overdue' : 'thread-stale'
    findings.push({
      ruleId: id,
      severity: 'warning',
      message: `「${r.thread.title}」：${r.reasons.join('；')}`,
      location: `第${input.chapterOrder}章`,
      suggestion: '安排回收或更新计划回收章',
    })
  }

  for (const t of input.plotThreads ?? []) {
    if (t.resolvedChapter != null && t.plantedChapter != null && t.resolvedChapter < t.plantedChapter) {
      findings.push({
        ruleId: 'foreshadow-order',
        severity: 'warning',
        message: `「${t.title}」回收章（${t.resolvedChapter}）早于埋设章（${t.plantedChapter}）`,
        location: '剧情线',
        suggestion: '修正章节号或拆成两条线',
      })
    }
  }
  return findings
}

/** 名称至少有一次不是作为更长候选名的前缀出现，才算独立提及。 */
function mentionedStandalone(content: string, name: string, allNames: string[]): boolean {
  let from = 0
  while (from <= content.length) {
    const idx = content.indexOf(name, from)
    if (idx < 0) return false
    const partOfLonger = allNames.some(
      (other) =>
        other.length > name.length &&
        other.startsWith(name) &&
        content.startsWith(other, idx),
    )
    if (!partOfLonger) return true
    from = idx + 1
  }
  return false
}

function checkNames(input: ContinuityCheckInput): ContinuityFinding[] {
  const names = (input.characterNames ?? []).filter((n) => n.trim().length >= 2)
  if (!names.length) return []
  const findings: ContinuityFinding[] = []
  const seen = new Map<string, string>()
  for (const name of names) {
    const key = normalizeName(name)
    const prev = seen.get(key)
    if (prev && prev !== name) {
      findings.push({
        ruleId: 'name-inconsistent',
        severity: 'warning',
        message: `同一角色存在两种写法：「${prev}」/「${name}」`,
        suggestion: '统一名称或补充别名表',
      })
      continue
    }
    seen.set(key, name)
  }

  // 正文同时出现“林夕”与“林夕儿”这类一字之差写法；张三/张三丰这类独立姓名不算
  const mentioned = names.filter((n) => mentionedStandalone(input.content, n, names))
  for (let i = 0; i < mentioned.length; i++) {
    for (let j = i + 1; j < mentioned.length; j++) {
      const a = mentioned[i]
      const b = mentioned[j]
      const [short, long] = a.length < b.length ? [a, b] : [b, a]
      if (long.length === short.length + 1 && long.startsWith(short)) {
        findings.push({
          ruleId: 'name-inconsistent',
          severity: 'warning',
          message: `本章同时出现「${short}」与「${long}」，疑似同一角色两种写法`,
          location: `第${input.chapterOrder}章`,
          suggestion: '确认是否为不同角色，否则统一写法',
          evidence: evidenceAround(input.content, long),
        })
      }
    }
  }
  return findings
}

function checkPromises(input: ContinuityCheckInput): ContinuityFinding[] {
  const promises = (input.previousPromises ?? []).filter((p) => p.trim())
  if (!promises.length) return []
  const findings: ContinuityFinding[] = []
  for (const promise of promises) {
    if (promiseMentioned(promise, input.content)) continue
    findings.push({
      ruleId: 'promise-unfulfilled',
      severity: 'warning',
      message: `上一章承诺「${promise}」在本章未见兑现`,
      location: `第${input.chapterOrder}章`,
      suggestion: '补写对应情节，或从承诺列表移除',
    })
  }
  return findings
}

/** 承诺是自然语言句子，允许按分句或 3 字片段命中，避免长句永远判不兑现。 */
function promiseMentioned(promise: string, content: string): boolean {
  const tokens = promise
    .split(/[，。！？、；;,\s]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  for (const token of tokens) {
    if (content.includes(token)) return true
    if (token.length >= 3) {
      for (let i = 0; i + 3 <= token.length; i++) {
        if (content.includes(token.slice(i, i + 3))) return true
      }
    }
  }
  return false
}

function checkHooks(input: ContinuityCheckInput): ContinuityFinding[] {
  const hooks = (input.hooks ?? []).filter((h) => h.trim())
  if (!hooks.length) return []
  const active = (input.sceneCards ?? []).filter((c) => c.status !== 'cut')
  const uncovered = active.length
    ? hooks.filter((h) => !active.some((c) => c.hooks.includes(h)))
    : hooks
  return uncovered.map((h) => ({
    ruleId: 'hooks-uncovered' as const,
    severity: 'warning' as const,
    message: active.length ? `细纲「${h}」未被任何场景卡覆盖` : `细纲「${h}」尚未拆成场景卡`,
    location: `第${input.chapterOrder}章`,
    suggestion: active.length ? '补充场景卡或在细纲中删除该条' : '先在场景卡面板按细纲补齐场景',
  }))
}

// ===== 入口 =====

/** 跑全量确定性规则；当前章之后的角色状态不参与判定。 */
export function runContinuityCheck(input: ContinuityCheckInput): ContinuityFinding[] {
  const latest = latestCharacterStates(input.characterStates, input.chapterOrder)
  const threads = input.plotThreads ?? []

  const findings: ContinuityFinding[] = [
    ...checkDeadCharacters(input, latest),
    ...checkEarlyItemsAndAbilities(input, latest),
    ...checkTimeReversal(input),
    ...checkDualLocation(input),
  ]

  if (threads.length) {
    findings.push(
      ...checkThreads(input, computeThreadRisks(threads, input.chapterOrder, input.staleAfter ?? 20))
    )
  }

  findings.push(...checkNames(input), ...checkPromises(input), ...checkHooks(input))

  return findings.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1
  )
}

export function summarizeContinuity(findings: ContinuityFinding[]): ContinuityReport {
  return {
    findings,
    blocking: findings.filter((f) => f.severity === 'blocking').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  }
}

export function ruleLabel(id: ContinuityRuleId): string {
  return CONTINUITY_RULES.find((r) => r.id === id)?.label ?? id
}
