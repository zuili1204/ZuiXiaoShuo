// 语料切章：单文件按章节标记切分，无标记时按分析块切分；目录按文件逐章。
// 纯函数，不依赖 Node/Electron，便于单测与渲染层复用。

export interface SplitChapter {
  title: string
  content: string
  /** 1-based 序号 */
  index: number
  charCount: number
  hash: string
  lowValue: boolean
}

export interface SplitResult {
  chapters: SplitChapter[]
  splitMode: 'chapter_markers' | 'analysis_blocks' | 'directory' | 'single'
  skippedTitles: string[]
  duplicateChapters: number
  lowValueChapters: number
  totalChars: number
}

const CHAPTER_MARKER =
  /(?:^|\n)\s*(?:(第\s*[\d零一二三四五六七八九十百千万两]+\s*[章节回卷](?:\s*[^\n]{0,40})?)|(Chapter\s+\d+[^\n]{0,40})|(#+\s*第[^\n]{0,40}章[^\n]{0,40}))/gi

const SKIP_TITLE = /^(作品简介|内容简介|简介|目录|作者的话|公告|感言|上架感言|完本感言|前言)\s*$/
const LOW_VALUE_CHARS = 500
const BLOCK_TARGET = 4000

/** FNV-1a 32 位；用于章节去重与内容哈希，跨平台稳定。 */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function normalizeCorpusText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeTitle(raw: string): string {
  return raw.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()
}

function makeChapter(title: string, content: string, index: number): SplitChapter {
  const text = content.trim()
  const charCount = text.replace(/\s/g, '').length
  return {
    title: title || `片段${String(index).padStart(2, '0')}`,
    content: text,
    index,
    charCount,
    hash: hashText(text),
    lowValue: charCount < LOW_VALUE_CHARS,
  }
}

function splitByMarkers(text: string): { chapters: Omit<SplitChapter, 'index' | 'hash' | 'lowValue' | 'charCount'>[]; skipped: string[] } {
  const matches = [...text.matchAll(CHAPTER_MARKER)]
  if (matches.length < 2) return { chapters: [], skipped: [] }

  const chapters: { title: string; content: string }[] = []
  const skipped: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0
    const end = i < matches.length - 1 ? matches[i + 1].index ?? text.length : text.length
    const title = normalizeTitle(matches[i][0])
    // 匹配可能从上一章末尾的换行开始；正文应跳过整个标题行，而不是按第一个换行切
    const markerEnd = start + matches[i][0].length
    const lineEnd = text.indexOf('\n', markerEnd)
    const content = text.slice(lineEnd >= 0 ? lineEnd + 1 : markerEnd, end).trim()
    if (SKIP_TITLE.test(title)) {
      skipped.push(title)
      continue
    }
    if (!content) continue
    chapters.push({ title, content })
  }
  return { chapters, skipped }
}

function splitByBlocks(text: string): { title: string; content: string }[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const blocks: { title: string; content: string }[] = []
  let buf: string[] = []
  let size = 0
  let index = 1
  const flush = () => {
    if (!buf.length) return
    blocks.push({ title: `片段${String(index).padStart(2, '0')}`, content: buf.join('\n\n') })
    index += 1
    buf = []
    size = 0
  }
  for (const p of paragraphs) {
    // 单段超长时先落块，避免 5 万字一段被整体截断
    if (p.length >= BLOCK_TARGET) {
      flush()
      buf.push(p)
      size = p.length
      flush()
      continue
    }
    if (size + p.length > BLOCK_TARGET && buf.length) flush()
    buf.push(p)
    size += p.length
  }
  flush()
  return blocks
}

/** 单文件切章；无章节标记时按 3000~5000 字分析块切分（不截断全文）。 */
export function splitChapters(raw: string, _filename = ''): SplitResult {
  const text = normalizeCorpusText(raw)
  if (!text) {
    return { chapters: [], splitMode: 'single', skippedTitles: [], duplicateChapters: 0, lowValueChapters: 0, totalChars: 0 }
  }

  const byMarker = splitByMarkers(text)
  const rawChapters = byMarker.chapters.length
    ? byMarker.chapters
    : byMarker.skipped.length
      ? [] // 只有简介/目录等非正文，交给调用方提示
      : splitByBlocks(text)

  const splitMode: SplitResult['splitMode'] = byMarker.chapters.length
    ? 'chapter_markers'
    : rawChapters.length > 1
      ? 'analysis_blocks'
      : 'single'

  const seen = new Set<string>()
  const chapters: SplitChapter[] = []
  let duplicateChapters = 0
  for (const item of rawChapters) {
    const chapter = makeChapter(item.title, item.content, chapters.length + 1)
    if (seen.has(chapter.hash)) {
      duplicateChapters += 1
      continue
    }
    seen.add(chapter.hash)
    chapters.push(chapter)
  }

  return {
    chapters,
    splitMode,
    skippedTitles: byMarker.skipped,
    duplicateChapters,
    lowValueChapters: chapters.filter((c) => c.lowValue).length,
    totalChars: chapters.reduce((sum, c) => sum + c.charCount, 0),
  }
}

/** 目录导入：每个文件一章，文件名作标题；按自然序排序。 */
export function splitDirectoryFiles(files: { name: string; content: string }[]): SplitResult {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  const seen = new Set<string>()
  const chapters: SplitChapter[] = []
  const skippedTitles: string[] = []
  let duplicateChapters = 0

  for (const file of sorted) {
    const title = normalizeTitle(file.name.replace(/\.[^.]+$/, ''))
    if (SKIP_TITLE.test(title)) {
      skippedTitles.push(title)
      continue
    }
    const content = normalizeCorpusText(file.content)
    if (!content) continue
    const chapter = makeChapter(title, content, chapters.length + 1)
    if (seen.has(chapter.hash)) {
      duplicateChapters += 1
      continue
    }
    seen.add(chapter.hash)
    chapters.push(chapter)
  }

  const totalChars = chapters.reduce((sum, c) => sum + c.charCount, 0)
  return {
    chapters,
    splitMode: 'directory',
    skippedTitles,
    duplicateChapters,
    lowValueChapters: chapters.filter((c) => c.lowValue).length,
    totalChars,
  }
}
