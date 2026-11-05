/**
 * 一致性确定性校验服务（P2-3 / P2-6）。
 *
 * - scanForeshadowParity：伏笔埋设/回收对账（移植 story-consistency/scripts/check-foreshadow-parity.js，
 *   正则与其保持一致），供 agent-service.runPipeline 的质量门禁 review 阶段调用，
 *   错配（回收无埋设 / 同章即收）并入 QualityGate 拦截。
 * - scanKbSqliteConsistency：KB（index.json / chapters/*.md）与 SQLite 表数据一致性扫描，
 *   打开小说时调用，差异仅告警不阻断。
 */
import { volumeService, chapterService, characterService, foreshadowingService } from './data-service'

const api = () => window.electronAPI

// 与 check-foreshadow-parity.js 完全一致的标记正则
const PLANT_RE = /\[F-([\w-]+)\s*[:：]?\s*埋设\]/g
const RESOLVE_RE = /\[F-([\w-]+)\s*[:：]?\s*回收\]/g

export interface ForeshadowParityResult {
  plantedCount: number
  resolvedCount: number
  /** 埋设了但从未回收（跨章视角的正常中间态，仅报告不拦截） */
  dangling: { id: string; where: string }[]
  /** 回收但扫描范围内无对应埋设（错配，门禁拦截） */
  orphanResolves: { id: string; where: string }[]
  /** 埋设与回收在同一单元内（同章即收，可疑，门禁拦截） */
  earlyResolves: { id: string; where: string }[]
  /** 是否通过对账（无错配） */
  ok: boolean
  report: string
}

/**
 * 扫描一组文本单元中的 [F-xx 埋设]/[F-xx 回收] 标记并对账。
 * 单章门禁场景传 [{ key: '本章', content }]：埋设未回收是正常中间态（后续章兑现），
 * 因此只有 orphanResolves / earlyResolves 拦截；全书扫描传全部章即可看到 dangling。
 */
export function scanForeshadowParity(units: { key: string; content: string }[]): ForeshadowParityResult {
  const planted = new Map<string, string>() // F-id -> 首次埋设单元
  const resolved = new Map<string, string>() // F-id -> 回收单元
  for (const { key, content } of units) {
    if (!content) continue
    let m: RegExpExecArray | null
    PLANT_RE.lastIndex = 0
    while ((m = PLANT_RE.exec(content))) {
      if (!planted.has(m[1])) planted.set(m[1], key)
    }
    RESOLVE_RE.lastIndex = 0
    while ((m = RESOLVE_RE.exec(content))) {
      resolved.set(m[1], key)
    }
  }

  const dangling: ForeshadowParityResult['dangling'] = []
  for (const [id, where] of planted) {
    if (!resolved.has(id)) dangling.push({ id, where })
  }
  const orphanResolves: ForeshadowParityResult['orphanResolves'] = []
  for (const [id, where] of resolved) {
    if (!planted.has(id)) orphanResolves.push({ id, where })
  }
  const earlyResolves: ForeshadowParityResult['earlyResolves'] = []
  for (const [id, where] of resolved) {
    if (planted.get(id) === where) earlyResolves.push({ id, where })
  }

  const ok = orphanResolves.length === 0 && earlyResolves.length === 0
  const parts: string[] = [`埋设 ${planted.size} 处、回收 ${resolved.size} 处`]
  if (orphanResolves.length) parts.push(`回收无埋设：${orphanResolves.map((x) => `[F-${x.id}]@${x.where}`).join('、')}`)
  if (earlyResolves.length) parts.push(`同章即收：${earlyResolves.map((x) => `[F-${x.id}]@${x.where}`).join('、')}`)
  if (dangling.length) parts.push(`未回收（中间态）：${dangling.map((x) => `[F-${x.id}]@${x.where}`).join('、')}`)
  return {
    plantedCount: planted.size,
    resolvedCount: resolved.size,
    dangling,
    orphanResolves,
    earlyResolves,
    ok,
    report: `伏笔对账：${parts.join('；')}`,
  }
}

// ===== P2-6：KB 与 SQLite 一致性扫描 =====

export interface KbConsistencyReport {
  /** index.json 声明但磁盘缺失的 KB 文件 */
  missingKbFiles: string[]
  /** SQLite 有摘要但 KB chapters/<id>.md 缺失的章节（如手动删文件） */
  missingChapterMd: { chapterId: string; title: string }[]
  counts: {
    indexEntries: number
    chaptersInDb: number
    chapterMdOnDisk: number
    charactersInDb: number
    foreshadowingsInDb: number
  }
  ok: boolean
  report: string
}

const kbRoot = (novelId: string) => `content/knowledge/${novelId}`

/**
 * 打开小说时比对 index.json / chapters/*.md 与表数据，差异告警（不阻断）。
 * 单一数据源原则：SQLite 是结构化数据的权威，KB 是派生物；缺文件即提示重建/修复。
 */
export async function scanKbSqliteConsistency(novelId: string): Promise<KbConsistencyReport> {
  const missingKbFiles: string[] = []
  const missingChapterMd: KbConsistencyReport['missingChapterMd'] = []

  // 1. index.json 声明的每个文件都应真实存在
  let indexEntries = 0
  try {
    const raw = await api()?.file?.read(`${kbRoot(novelId)}/index.json`)
    if (raw) {
      const index = JSON.parse(raw) as { files?: Record<string, unknown> }
      const files = index.files ?? {}
      indexEntries = Object.keys(files).length
      for (const rel of Object.keys(files)) {
        const exists = await api()?.file?.exists(`${kbRoot(novelId)}/${rel}`)
        if (!exists) missingKbFiles.push(rel)
      }
    }
  } catch (e) {
    console.warn('[kb-consistency] index.json 读取失败（可能尚未初始化）:', e)
  }

  // 2. SQLite 有摘要的章节都应有 KB chapters/<id>.md（_writeChapterMd 的落盘产物）
  let chaptersInDb = 0
  let chapterMdOnDisk = 0
  let charactersInDb = 0
  let foreshadowingsInDb = 0
  try {
    const vols = await volumeService.getByNovelId(novelId)
    for (const v of vols) {
      const chs = await chapterService.getByVolumeId(v.id)
      chaptersInDb += chs.length
      for (const ch of chs) {
        if (!ch.summary) continue // 无摘要的章节尚未写入 KB，属正常
        const exists = await api()?.file?.exists(`${kbRoot(novelId)}/chapters/${ch.id}.md`)
        if (exists) chapterMdOnDisk += 1
        else missingChapterMd.push({ chapterId: ch.id, title: ch.title })
      }
    }
    charactersInDb = (await characterService.getByNovelId(novelId)).length
    foreshadowingsInDb = (await foreshadowingService.getByNovelId(novelId)).length
  } catch (e) {
    console.warn('[kb-consistency] 表数据读取失败:', e)
  }

  const ok = missingKbFiles.length === 0 && missingChapterMd.length === 0
  const parts: string[] = [
    `index 条目 ${indexEntries}`,
    `章 ${chaptersInDb}（有摘要且 KB 缺 md：${missingChapterMd.length}）`,
    `角色 ${charactersInDb}`,
    `伏笔 ${foreshadowingsInDb}`,
  ]
  if (missingKbFiles.length) parts.push(`KB 文件缺失：${missingKbFiles.join('、')}`)
  if (missingChapterMd.length)
    parts.push(`章节 md 缺失：${missingChapterMd.map((c) => `《${c.title}》`).join('、')}`)
  return {
    missingKbFiles,
    missingChapterMd,
    counts: { indexEntries, chaptersInDb, chapterMdOnDisk, charactersInDb, foreshadowingsInDb },
    ok,
    report: ok ? `KB/SQLite 一致性正常（${parts.join('；')}）` : `KB/SQLite 不一致（${parts.join('；')}）`,
  }
}
