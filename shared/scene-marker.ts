/**
 * 正文场景边界标记。
 *
 * 正文明文保持 Markdown，场景边界用 HTML 注释标记：`<!-- scene:<sceneId> -->`。
 * 导出时剥离；重写单个场景时只替换相邻标记之间的区间，不依赖字符偏移。
 */

const MARKER_SOURCE = '<!--\\s*scene:([A-Za-z0-9_-]+)\\s*-->'
const NEXT_MARKER_RE = /<!--\s*scene:[A-Za-z0-9_-]+\s*-->/

export function sceneMarker(sceneId: string): string {
  return `<!-- scene:${sceneId} -->`
}

export function stripSceneMarkers(text: string): string {
  return text.replace(new RegExp(MARKER_SOURCE, 'g'), '')
}

/** 删除单个场景标记，保留正文（删卡后的孤立标记清理）。 */
export function removeSceneMarker(text: string, sceneId: string): string {
  return text.replace(sceneMarker(sceneId), '').replace(/\n{4,}/g, '\n\n\n')
}

export function hasSceneMarkers(text: string): boolean {
  return new RegExp(MARKER_SOURCE).test(text)
}

export interface SceneSegment {
  sceneId: string | null
  /** 标记之前的开场白（无卡归属）；带标记的段为标记后的正文 */
  text: string
  /** 标记起始位置（无标记段为 0） */
  start: number
  /** 段结束位置（下一个标记起始或文本末尾） */
  end: number
}

export function splitSceneSegments(text: string): SceneSegment[] {
  const segments: SceneSegment[] = []
  const markerRe = new RegExp(MARKER_SOURCE, 'g')
  let match: RegExpExecArray | null
  let cursor = 0
  let pendingId: string | null = null
  let pendingStart = 0

  while ((match = markerRe.exec(text)) !== null) {
    if (match.index > cursor || pendingId) {
      segments.push({
        sceneId: pendingId,
        text: stripSceneMarkers(text.slice(cursor, match.index)),
        start: pendingId ? pendingStart : cursor,
        end: match.index,
      })
    }
    cursor = match.index + match[0].length
    pendingId = match[1]
    pendingStart = match.index
  }

  if (cursor < text.length || pendingId) {
    segments.push({
      sceneId: pendingId,
      text: stripSceneMarkers(text.slice(cursor)),
      start: pendingId ? pendingStart : cursor,
      end: text.length,
    })
  }
  return segments
}

/** 读取某场景的正文（不含标记）；找不到返回 null。 */
export function extractSceneContent(text: string, sceneId: string): string | null {
  const marker = sceneMarker(sceneId)
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return null
  const bodyStart = markerIndex + marker.length
  const rest = text.slice(bodyStart)
  const next = rest.search(NEXT_MARKER_RE)
  const bodyEnd = next < 0 ? text.length : bodyStart + next
  return text.slice(bodyStart, bodyEnd).trim()
}

/**
 * 替换指定场景正文，保留标记本身。
 * 返回 null 表示正文中没有该场景标记（调用方应回退为整章重写）。
 */
export function replaceSceneContent(text: string, sceneId: string, newContent: string): string | null {
  const marker = sceneMarker(sceneId)
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return null

  const bodyStart = markerIndex + marker.length
  const rest = text.slice(bodyStart)
  const next = rest.search(NEXT_MARKER_RE)
  const bodyEnd = next < 0 ? text.length : bodyStart + next

  const body = stripSceneMarkers(newContent).trim()
  const prefix = text.slice(0, markerIndex)
  const suffix = text.slice(bodyEnd)
  const replacement = `${marker}\n\n${body}\n\n`

  const merged = `${prefix}${replacement}${suffix}`
  // 只收敛替换点附近的空白，避免整章行距被重排
  return merged.replace(/\n{4,}/g, '\n\n\n')
}

/**
 * 首次拆卡时为已有正文插入场景标记。
 * 按非空段落均分为 N 组，每组第一段前放一个标记；段落不足时后续场景为空段。
 */
export function insertSceneMarkersAtParagraphs(text: string, sceneIds: string[]): string {
  if (!sceneIds.length) return text
  if (hasSceneMarkers(text)) return text

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())
  if (!paragraphs.length) {
    return sceneIds.map((id) => `${sceneMarker(id)}\n\n`).join('').trimEnd()
  }

  const groups: string[][] = Array.from({ length: sceneIds.length }, () => [])
  paragraphs.forEach((p, i) => {
    const groupIndex = Math.min(sceneIds.length - 1, Math.floor((i * sceneIds.length) / paragraphs.length))
    groups[groupIndex].push(p)
  })

  return sceneIds
    .map((id, i) => `${sceneMarker(id)}\n\n${groups[i].join('\n\n')}${groups[i].length ? '\n\n' : ''}`)
    .join('')
    .trimEnd()
}
