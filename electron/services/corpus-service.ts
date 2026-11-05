// P2 语料导入与相似度：主进程负责文件读取/编码识别/规范化落盘，
// LLM 分析仍在渲染层调用（主进程不调用 LLM）。
import { promises as fs } from 'fs'
import { basename, join, isAbsolute, resolve as resolvePath } from 'path'
import { FileService } from './file-service'
import { splitChapters, splitDirectoryFiles, hashText, type SplitResult } from '../../shared/chapter-split'
import type {
  CorpusManifest,
  CorpusPreview,
  StyleSourceKind,
  SimilarityHit,
  SimilarityReport,
} from '../../shared/style-types'

const MAX_PASTE_CHARS = 50_000
const MAX_DIR_FILES = 5000
const LOW_SAMPLE_CHAPTERS = 10
const LOW_SAMPLE_CHARS = 50_000

interface PreviewInput {
  path?: string
  kind: StyleSourceKind
  text?: string
}

/** UTF-8 严格解码优先；失败回退 GB18030（Electron 内置 ICU 支持）。 */
export function decodeCorpus(buffer: Buffer): { text: string; encoding: string; invalidRatio: number } {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le', invalidRatio: 0 }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer), encoding: 'utf-16be', invalidRatio: 0 }
  }
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { text: hasBom ? text.replace(/^\uFEFF/, '') : text, encoding: hasBom ? 'utf-8-bom' : 'utf-8', invalidRatio: 0 }
  } catch {
    const text = new TextDecoder('gb18030').decode(buffer)
    const bad = (text.match(/\uFFFD/g) || []).length
    return { text, encoding: 'gb18030', invalidRatio: text.length ? bad / text.length : 0 }
  }
}

function charsWithoutSpace(text: string): number {
  return text.replace(/\s/g, '').length
}

async function readDirectoryCorpus(dir: string): Promise<{ files: { name: string; content: string }[]; skipped: string[]; encoding: string }> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: { name: string; content: string }[] = []
  const skipped: string[] = []
  let encoding = 'utf-8'
  for (const entry of entries) {
    if (files.length >= MAX_DIR_FILES) break
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      skipped.push(`${entry.name}/`)
      continue
    }
    if (!/\.(txt|md)$/i.test(entry.name)) {
      skipped.push(entry.name)
      continue
    }
    const buffer = await fs.readFile(full)
    const decoded = decodeCorpus(buffer)
    encoding = decoded.encoding
    files.push({ name: entry.name, content: decoded.text })
  }
  return { files, skipped, encoding }
}

async function buildPreview(input: PreviewInput): Promise<{ preview: CorpusPreview; split: SplitResult; encoding: string }> {
  const kind = input.kind
  let split: SplitResult
  let encoding = 'utf-8'
  const skippedFiles: string[] = []
  const originPath = input.path ?? ''
  const warnings: string[] = []

  if (kind === 'paste') {
    const text = String(input.text ?? '')
    if (text.length > MAX_PASTE_CHARS) warnings.push(`粘贴内容超过 ${MAX_PASTE_CHARS} 字，请改用文件导入`)
    const clipped = text.slice(0, MAX_PASTE_CHARS)
    split = splitChapters(clipped, '粘贴文本')
  } else if (kind === 'chapter_dir') {
    if (!originPath) throw new Error('未选择语料目录')
    const dirStat = await fs.stat(originPath).catch(() => null)
    if (!dirStat?.isDirectory()) throw new Error('目录不存在或不可读')
    const dir = await readDirectoryCorpus(originPath)
    encoding = dir.encoding
    skippedFiles.push(...dir.skipped)
    split = splitDirectoryFiles(dir.files)
  } else {
    if (!originPath) throw new Error('未选择语料文件')
    const stat = await fs.stat(originPath).catch(() => null)
    if (!stat?.isFile()) throw new Error('文件不存在或不可读')
    const decoded = decodeCorpus(await fs.readFile(originPath))
    encoding = decoded.encoding
    if (decoded.invalidRatio > 0.005) warnings.push('文本含较多替换字符，建议手动确认编码或另存为 UTF-8')
    split = splitChapters(decoded.text, basename(originPath))
  }

  if (split.chapters.length === 0) warnings.push('未识别出正文，请检查文件内容或换用其他导入方式')
  if (split.chapters.length < LOW_SAMPLE_CHAPTERS || split.totalChars < LOW_SAMPLE_CHARS) {
    warnings.push(`样本偏少（${split.chapters.length} 章 / ${split.totalChars} 字），画像置信度会偏低`)
  }
  if (split.duplicateChapters > 0) warnings.push(`已跳过 ${split.duplicateChapters} 个重复章节`)

  const contentHash = hashText(split.chapters.map((c) => c.hash).join('|'))
  const preview: CorpusPreview = {
    kind,
    originPath,
    encoding,
    splitMode: split.splitMode,
    chapters: split.chapters.map((c) => ({
      index: c.index,
      title: c.title,
      // 预览阶段还没有 sourceId，路径在 import 时回填
      path: '',
      charCount: c.charCount,
      hash: c.hash,
      lowValue: c.lowValue,
    })),
    skippedFiles,
    duplicateChapters: split.duplicateChapters,
    lowValueChapters: split.lowValueChapters,
    totalChars: split.totalChars,
    contentHash,
    warnings,
  }
  return { preview, split, encoding }
}

export class CorpusService {
  constructor(private fileService: FileService) {}

  private baseDir(): string {
    return this.fileService.getBaseDir()
  }

  private absolute(relPath: string): string {
    return isAbsolute(relPath) ? relPath : resolvePath(this.baseDir(), relPath)
  }

  async preview(input: PreviewInput): Promise<CorpusPreview> {
    const { preview } = await buildPreview(input)
    return preview
  }

  async import(input: PreviewInput & { sourceId: string; name: string }): Promise<CorpusManifest> {
    const sourceId = String(input.sourceId ?? '').trim()
    if (!/^[a-zA-Z0-9_-]{6,64}$/.test(sourceId)) throw new Error('来源标识不合法')
    const { preview, split, encoding } = await buildPreview(input)
    if (!split.chapters.length) throw new Error('语料中没有可导入的正文')

    const rootRel = `content/styles/${sourceId}`
    const chaptersRel = `${rootRel}/chapters`
    const rootAbs = this.absolute(rootRel)
    await fs.mkdir(join(rootAbs, 'chapters'), { recursive: true })
    await fs.mkdir(join(rootAbs, 'profile'), { recursive: true })

    const chapters = []
    for (const chapter of split.chapters) {
      const fileName = `${String(chapter.index).padStart(4, '0')}.txt`
      const rel = `${chaptersRel}/${fileName}`
      // 统一走 fileService 原子写，避免中断留下半截章节
      await this.fileService.writeFile(rel, chapter.content)
      chapters.push({
        index: chapter.index,
        title: chapter.title,
        path: rel,
        charCount: chapter.charCount,
        hash: chapter.hash,
        lowValue: chapter.lowValue,
      })
    }

    const manifest: CorpusManifest = {
      ...preview,
      sourceId,
      name: input.name || basename(input.path || '未命名语料'),
      importedAt: new Date().toISOString(),
      encoding,
      chapters,
      totalChars: chapters.reduce((s, c) => s + c.charCount, 0),
    }
    await this.fileService.writeFile(`${rootRel}/manifest.json`, JSON.stringify(manifest, null, 2))
    // 空目录（profile/）保持存在，便于后续落盘画像；manifest 是章节顺序的唯一事实来源
    await fs.mkdir(join(rootAbs, 'profile'), { recursive: true })
    return manifest
  }

  async delete(sourceId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{6,64}$/.test(String(sourceId ?? ''))) throw new Error('来源标识不合法')
    await this.fileService.deleteDir(`content/styles/${sourceId}`)
  }

  async loadManifest(sourceId: string): Promise<CorpusManifest> {
    const raw = await this.fileService.readFile(`content/styles/${sourceId}/manifest.json`)
    return JSON.parse(raw) as CorpusManifest
  }

  async readChapterTexts(sourceIds: string[]): Promise<{ sourceId: string; texts: string[] }[]> {
    const out: { sourceId: string; texts: string[] }[] = []
    for (const sourceId of sourceIds) {
      try {
        const manifest = await this.loadManifest(sourceId)
        const texts: string[] = []
        for (const chapter of manifest.chapters) {
          try {
            texts.push(await this.fileService.readFile(chapter.path))
          } catch {
            // 单章缺失不阻断整本相似度检查
          }
        }
        out.push({ sourceId, texts })
      } catch {
        // 来源缺失时跳过，调用方按“全部缺失回退无风格”处理
      }
    }
    return out
  }

  async similarity(input: { text: string; sourceIds?: string[]; entities?: string[] }): Promise<SimilarityReport> {
    const text = normalizeForMatch(String(input.text ?? ''))
    const sources = await this.readChapterTexts(input.sourceIds ?? [])
    const hits: SimilarityHit[] = []

    const textNgrams = ngramSet(text, 12)
    let overlap = 0
    if (textNgrams.size) {
      const sourceNgrams = new Set<string>()
      for (const source of sources) {
        for (const chapter of source.texts) {
          for (const gram of ngramSet(normalizeForMatch(chapter), 12)) sourceNgrams.add(gram)
        }
      }
      for (const gram of textNgrams) if (sourceNgrams.has(gram)) overlap += 1
    }
    const ngramRate = textNgrams.size ? +(overlap / textNgrams.size * 100).toFixed(2) : 0
    if (ngramRate > 8) {
      hits.push({
        kind: 'ngram',
        value: `${ngramRate}%`,
        severity: ngramRate > 15 ? 'blocking' : 'advisory',
        detail: `12 字片段重合率 ${ngramRate}%${ngramRate > 15 ? '，已超过 15% 上限' : '，建议改写高度重合段落'}`,
      })
    }

    let longest = 0
    for (const source of sources) {
      for (const chapter of source.texts) {
        longest = Math.max(longest, longestCommonSubstring(text, normalizeForMatch(chapter)))
        if (longest > 200) break
      }
    }
    if (longest > 30) {
      hits.push({
        kind: 'lcs',
        value: `${longest} 字`,
        severity: longest > 50 ? 'blocking' : 'advisory',
        detail: `与来源存在 ${longest} 字连续相同片段${longest > 50 ? '，请人工确认是否为误用原文' : ''}`,
      })
    }

    const entityHits = new Map<string, number>()
    for (const entity of input.entities ?? []) {
      if (!entity || entity.length < 2) continue
      const count = text.split(entity).length - 1
      if (count > 0) entityHits.set(entity, count)
    }
    if (entityHits.size) {
      const names = [...entityHits.keys()]
      const repeated = names.filter((n) => (entityHits.get(n) ?? 0) >= 3)
      hits.push({
        kind: 'entity',
        value: names.slice(0, 8).join('、'),
        severity: repeated.length ? 'blocking' : 'advisory',
        detail: repeated.length
          ? `专有名词「${repeated.slice(0, 3).join('、')}」出现 3 次以上，疑似把来源设定带入本章`
          : '正文命中来源专有名词，请确认没有复用来源人物/地名',
      })
    }

    return {
      ngramRate,
      longestCommon: longest,
      hits,
      blocking: hits.filter((h) => h.severity === 'blocking').length,
      advisory: hits.filter((h) => h.severity === 'advisory').length,
    }
  }
}

function normalizeForMatch(text: string): string {
  return text
    .replace(/[“”"'「」『』（）()【】\[\]《》〈〉，。！？、；：…—\s]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
}

function ngramSet(text: string, n: number): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n))
  return out
}

/** 二分 + 双端前缀哈希校验，避免对百万字语料做 O(n·m) 扫描。 */
export function longestCommonSubstring(a: string, b: string, maxLen = 400): number {
  if (!a || !b) return 0
  const longerText = a.length >= b.length ? a : b
  const shorterText = a.length >= b.length ? b : a
  const upper = Math.min(maxLen, shorterText.length)
  const shorter = prefixHash(shorterText)
  const longer = prefixHash(longerText)
  let best = 0
  let lo = 1
  let hi = upper
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (hasCommonWindow(shorter, longer, mid)) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

const HASH_BASE = 131
const HASH_MOD = 2147483647

interface PrefixHash {
  text: string
  prefix: number[]
  pow: number[]
}

function prefixHash(text: string): PrefixHash {
  const prefix = new Array<number>(text.length + 1)
  const pow = new Array<number>(text.length + 1)
  prefix[0] = 0
  pow[0] = 1
  for (let i = 0; i < text.length; i++) {
    prefix[i + 1] = (prefix[i] * HASH_BASE + text.charCodeAt(i)) % HASH_MOD
    pow[i + 1] = (pow[i] * HASH_BASE) % HASH_MOD
  }
  return { text, prefix, pow }
}

function windowHash(h: PrefixHash, start: number, len: number): number {
  const raw = (h.prefix[start + len] - (h.prefix[start] * h.pow[len]) % HASH_MOD) % HASH_MOD
  return raw < 0 ? raw + HASH_MOD : raw
}

function hasCommonWindow(shorter: PrefixHash, longer: PrefixHash, len: number): boolean {
  if (len <= 0 || len > shorter.text.length) return false
  const windows = new Map<number, number>()
  for (let i = 0; i + len <= shorter.text.length; i++) {
    const h = windowHash(shorter, i, len)
    if (!windows.has(h)) windows.set(h, i)
  }
  for (let i = 0; i + len <= longer.text.length; i++) {
    const h = windowHash(longer, i, len)
    const pos = windows.get(h)
    if (
      pos !== undefined &&
      shorter.text.slice(pos, pos + len) === longer.text.slice(i, i + len)
    ) {
      return true
    }
  }
  return false
}
