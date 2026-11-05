// 导出服务 — 支持将小说导出为 .md / .txt / .docx 文件

import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import { novelService, volumeService, chapterService } from './data-service'
import { stripSceneMarkers } from '@shared/scene-marker'

export interface ExportOptions {
  format: 'md' | 'txt' | 'docx'
  includeTitle: boolean
  includeHeader: boolean
  /** 导出范围：'all' 全部，或 { startChapter, endChapter } 全局章节序号（从 1 开始，闭区间） */
  range?: 'all' | { startChapter: number; endChapter: number }
}

const DEFAULT_OPTIONS: ExportOptions = {
  format: 'md',
  includeTitle: true,
  includeHeader: true,
  range: 'all',
}

/** D-T10-2：将 Markdown 文本转为纯文本（TXT/DOCX 导出用），format 不再只影响扩展名。 */
export function stripMarkdown(text: string): string {
  return (text || '')
    // 围栏代码块：去掉围栏行，保留内容
    .replace(/```[^\n]*\n?/g, '')
    // 图片/链接：![alt](url) -> alt；[text](url) -> text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 行首标题 / 引用 / 列表标记
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
    // 水平线（整行仅由 -/_/*/空格 组成且不少于 3 个符号）
    .replace(/^\s{0,3}([-_*]\s?){3,}$/gm, '')
    // 行内强调与行内代码
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
}

interface GatheredChapter {
  title: string
  order: number
  content: string
  /** loadContent 失败（无正文文件）标记，各格式自行决定占位文案 */
  missing?: boolean
}

interface GatheredVolume {
  volTitle: string
  chapters: GatheredChapter[]
}

interface GatheredNovel {
  title: string
  description: string
  volumes: GatheredVolume[]
}

/** 取数：小说元信息 + 卷/章正文（按全局序号范围筛选后按卷分组）。md/txt/docx 共用。 */
async function gatherNovel(novelId: string, options: Partial<ExportOptions> = {}): Promise<GatheredNovel> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const novel = await novelService.getById(novelId)
  if (!novel) throw new Error('小说不存在或已被删除')

  const vols = await volumeService.getByNovelId(novelId)

  // 扁平化所有章节（按卷序 + 章序）以支持全局序号范围筛选
  const allChapters: { vol: typeof vols[0]; ch: Awaited<ReturnType<typeof chapterService.getByVolumeId>>[0] }[] = []
  for (const vol of vols) {
    const chapters = await chapterService.getByVolumeId(vol.id)
    for (const ch of chapters) {
      allChapters.push({ vol, ch })
    }
  }

  const totalChapters = allChapters.length
  const range = opts.range ?? 'all'
  const isRange = range !== 'all' && typeof range === 'object'
  const startIdx = isRange ? Math.max(0, range.startChapter - 1) : 0
  const endIdx = isRange ? Math.min(totalChapters, range.endChapter) : totalChapters
  const selected = allChapters.slice(startIdx, endIdx)

  // 按卷分组选中章节
  const volMap = new Map<string, { vol: typeof vols[0]; items: typeof selected }>()
  for (const item of selected) {
    let group = volMap.get(item.vol.id)
    if (!group) {
      group = { vol: item.vol, items: [] }
      volMap.set(item.vol.id, group)
    }
    group.items.push(item)
  }

  const volumes: GatheredVolume[] = []
  for (const [, group] of volMap) {
    const chapters: GatheredChapter[] = []
    for (const { ch } of group.items) {
      try {
        chapters.push({
          title: ch.title,
          order: ch.order,
          content: stripSceneMarkers(await chapterService.loadContent(ch.id)),
        })
      } catch {
        chapters.push({ title: ch.title, order: ch.order, content: '', missing: true })
      }
    }
    volumes.push({ volTitle: group.vol.title, chapters })
  }

  return { title: novel.title, description: novel.description ?? '', volumes }
}

export async function exportNovel(novelId: string, options: Partial<ExportOptions> = {}): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const isTxt = opts.format === 'txt'
  const data = await gatherNovel(novelId, opts)

  let output = ''

  if (opts.includeTitle) {
    if (isTxt) {
      output += `《${data.title}》\n\n`
      if (data.description) {
        output += `${stripMarkdown(data.description)}\n\n`
      }
    } else {
      output += `# ${data.title}\n\n`
      if (data.description) {
        output += `${data.description}\n\n`
      }
      output += `---\n\n`
    }
  }

  for (const vol of data.volumes) {
    if (opts.includeHeader) {
      output += isTxt ? `【${vol.volTitle}】\n\n` : `## ${vol.volTitle}\n\n`
    }
    for (const ch of vol.chapters) {
      output += isTxt ? `第${ch.order}章 · ${ch.title}\n\n` : `### 第${ch.order}章 · ${ch.title}\n\n`
      if (ch.missing) {
        output += isTxt ? '(无内容)\n\n' : '*(无内容)*\n\n'
      } else {
        output += (isTxt ? stripMarkdown(ch.content) : ch.content).trim() + '\n\n'
      }
    }
  }

  return output
}

/**
 * DOCX 导出：返回二进制内容，由 exportAsFile 经 file.writeBase64 落盘（或浏览器 Blob 下载）。
 * 卷 = 一级标题，章 = 二级标题，正文 stripMarkdown 后按非空行分段。
 */
export async function exportNovelDocx(novelId: string, options: Partial<ExportOptions> = {}): Promise<Uint8Array> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const data = await gatherNovel(novelId, opts)

  const children: Paragraph[] = []

  if (opts.includeTitle) {
    children.push(new Paragraph({ text: data.title, heading: HeadingLevel.TITLE }))
    if (data.description) {
      children.push(new Paragraph({ text: stripMarkdown(data.description) }))
    }
  }

  for (const vol of data.volumes) {
    if (opts.includeHeader) {
      children.push(new Paragraph({ text: vol.volTitle, heading: HeadingLevel.HEADING_1 }))
    }
    for (const ch of vol.chapters) {
      children.push(new Paragraph({ text: `第${ch.order}章 · ${ch.title}`, heading: HeadingLevel.HEADING_2 }))
      if (ch.missing) {
        children.push(new Paragraph({ text: '(无内容)' }))
      } else {
        for (const line of stripMarkdown(ch.content).trim().split('\n')) {
          const text = line.trim()
          if (text) children.push(new Paragraph({ text }))
        }
      }
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] })
  return blobToUint8Array(await Packer.toBlob(doc))
}

/** 获取小说总章节数（供 UI 显示范围提示） */
export async function getChapterCount(novelId: string): Promise<number> {
  const vols = await volumeService.getByNovelId(novelId)
  let count = 0
  for (const vol of vols) {
    const chapters = await chapterService.getByVolumeId(vol.id)
    count += chapters.length
  }
  return count
}

export async function exportChapter(chapterId: string, options: Partial<ExportOptions> = {}): Promise<string> {
  const content = stripSceneMarkers(await chapterService.loadContent(chapterId))
  return options.format === 'txt' ? stripMarkdown(content) : `# Chapter\n\n${content}`
}

/** 二进制转 base64：分块 String.fromCharCode 避免 call stack 溢出，再 btoa 编码 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** Blob → Uint8Array：优先 arrayBuffer()，jsdom 等环境的 Blob 没有该方法时退回 FileReader */
async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

/**
 * D-T10-1：返回是否真正落盘。用户取消保存对话框（filePath 为空）返回 false，
 * 上层据此避免把「取消」记成 export success。
 * DOCX 等二进制内容传 Uint8Array，走 file.writeBase64 通道。
 */
export async function exportAsFile(content: string | Uint8Array, filename: string, format: 'md' | 'txt' | 'docx' = 'md'): Promise<boolean> {
  if (window.electronAPI) {
    const filePath = await window.electronAPI.dialog.saveFile(filename)
    if (!filePath) return false
    if (typeof content === 'string') {
      await window.electronAPI.file.write(filePath, content)
    } else {
      await window.electronAPI.file.writeBase64(filePath, bytesToBase64(content))
    }
    return true
  }
  // 浏览器回退：下载文件
  const mimeType = format === 'md' ? 'text/markdown' : format === 'docx' ? DOCX_MIME : 'text/plain'
  const blob = typeof content === 'string'
    ? new Blob([content], { type: mimeType })
    : new Blob([content.slice().buffer as ArrayBuffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return true
}
