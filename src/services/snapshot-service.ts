// 章节快照服务：纯文件方案，零 DB 迁移
// 存储布局：content/snapshots/<novelId>/<chapterId>/<yyyyMMdd-HHmmss>-<source>.md
// 文件名可排序可解析：限流与保留策略均从文件名推导，无内存态，进程重启安全。
import { chapterService } from './data-service'

const api = () => window.electronAPI

export type SnapshotSource = 'auto' | 'manual' | 'finish' | 'pipeline' | 'pre-restore'

export interface SnapshotMeta {
  name: string
  ts: number
  source: SnapshotSource
  // 同秒冲突序号（无后缀为 0），用于同一时间戳内稳定排序
  seq: number
}

const SNAPSHOT_ROOT = 'content/snapshots'
// 同章 auto 快照限流间隔：10 分钟内最多 1 份
const AUTO_INTERVAL_MS = 10 * 60 * 1000
// 每章保留上限，超出按时间删最老
const MAX_PER_CHAPTER = 50

const SOURCE_LABELS: Record<SnapshotSource, string> = {
  auto: '自动',
  manual: '手动',
  finish: '完成本章',
  pipeline: '流水线',
  'pre-restore': '恢复前',
}

export function snapshotSourceLabel(source: string): string {
  return SOURCE_LABELS[source as SnapshotSource] ?? source
}

const pad = (n: number) => String(n).padStart(2, '0')

function formatStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

// <yyyyMMdd-HHmmss>-<source>[-<seq>].md → 元数据；解析失败返回 null（跳过脏文件）
// 同秒冲突会写 -1/-2 后缀，必须一并识别，否则这些快照永远列不出、也不会被保留策略回收。
const SNAPSHOT_RE = /^(\d{8})-(\d{6})-(auto|manual|finish|pipeline|pre-restore)(?:-(\d+))?\.md$/

export function parseSnapshotName(name: string): SnapshotMeta | null {
  const m = SNAPSHOT_RE.exec(name)
  if (!m) return null
  const [, ymd, hms, source, seqRaw] = m
  const ts = Date.parse(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` +
    `T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`
  )
  if (Number.isNaN(ts)) return null
  return { name, ts, source: source as SnapshotSource, seq: seqRaw ? Number(seqRaw) : 0 }
}

function snapshotDir(novelId: string, chapterId: string): string {
  return `${SNAPSHOT_ROOT}/${novelId}/${chapterId}`
}

async function listNames(dir: string): Promise<string[]> {
  try {
    const names = await api().file.list(dir)
    return Array.isArray(names) ? names : []
  } catch {
    return [] // 目录不存在 = 无快照
  }
}

async function listMetas(dir: string): Promise<SnapshotMeta[]> {
  const metas: SnapshotMeta[] = []
  for (const name of await listNames(dir)) {
    const m = parseSnapshotName(name)
    if (m) metas.push(m)
  }
  return metas.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
}

async function resolveNovelIdByChapter(chapterId: string): Promise<string | null> {
  try {
    const chapter = await chapterService.getById(chapterId)
    if (!chapter) return null
    const rows = (await api().db.query('SELECT novel_id FROM volumes WHERE id = ?', [chapter.volumeId])) as any[]
    return rows[0]?.novel_id ?? null
  } catch {
    return null
  }
}

// 创建快照：读取当前正文 → 限流检查 → 写入 → 裁剪超额
// 返回是否实际写入（auto 被限流 / 空章节时为 false）
export async function createSnapshot(
  chapterId: string,
  source: SnapshotSource,
  opts?: { force?: boolean }
): Promise<boolean> {
  const novelId = await resolveNovelIdByChapter(chapterId)
  if (!novelId) return false

  const content = await chapterService.loadContent(chapterId)
  if (!content) return false // 空章节不值得快照

  const dir = snapshotDir(novelId, chapterId)
  const metas = await listMetas(dir)

  // auto 限流：10 分钟内已有 auto 快照则跳过（force 不限流）
  if (source === 'auto' && !opts?.force) {
    const lastAuto = [...metas].reverse().find((m) => m.source === 'auto')
    if (lastAuto && Date.now() - lastAuto.ts < AUTO_INTERVAL_MS) return false
  }

  // 文件名冲突兜底：同一秒内重复快照时追加序号（固定时间戳，避免跨秒时后缀无意义）
  const stamp = formatStamp(new Date())
  let name = `${stamp}-${source}.md`
  const existing = new Set(metas.map((m) => m.name))
  let seq = 1
  while (existing.has(name)) {
    name = `${stamp}-${source}-${seq++}.md`
  }

  await api().file.write(`${dir}/${name}`, content)

  // 保留策略：超出上限删最老
  const all = await listMetas(dir)
  const overflow = all.length - MAX_PER_CHAPTER
  for (let i = 0; i < overflow; i++) {
    try {
      await api().file.delete(`${dir}/${all[i].name}`)
    } catch {
      /* 删除失败不阻塞主流程 */
    }
  }
  return true
}

// 列出某章快照（新的在前）
export async function listSnapshots(chapterId: string): Promise<SnapshotMeta[]> {
  const novelId = await resolveNovelIdByChapter(chapterId)
  if (!novelId) return []
  const metas = await listMetas(snapshotDir(novelId, chapterId))
  return metas.reverse()
}

// 读取快照内容（name 做合法性校验，防路径拼接）
export async function readSnapshot(chapterId: string, name: string): Promise<string> {
  const novelId = await resolveNovelIdByChapter(chapterId)
  if (!novelId) throw new Error('章节不存在')
  if (!parseSnapshotName(name)) throw new Error('非法的快照文件名')
  return api().file.read(`${snapshotDir(novelId, chapterId)}/${name}`)
}

// 恢复快照：恢复前强制留存当前内容（pre-restore），再经 saveContent 咽喉写回
// 返回恢复后的正文，供调用方刷新 RAG 索引等
export async function restoreSnapshot(chapterId: string, name: string): Promise<string> {
  const content = await readSnapshot(chapterId, name)
  await createSnapshot(chapterId, 'pre-restore', { force: true })
  await chapterService.saveContent(chapterId, content)
  return content
}
