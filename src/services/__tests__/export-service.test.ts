import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock data-service：固定一本书 / 一卷 / 一章
vi.mock('../data-service', () => ({
  novelService: {
    getById: vi.fn(async (id: string) =>
      id === 'n1' ? { id: 'n1', title: '测试书', description: '简介**加粗**与*斜体*' } : null),
  },
  volumeService: {
    getByNovelId: vi.fn(async () => [{ id: 'v1', novelId: 'n1', title: '第一卷', order: 1, summary: '' }]),
  },
  chapterService: {
    getByVolumeId: vi.fn(async () => [{ id: 'c1', volumeId: 'v1', title: '初见', order: 1 }]),
    loadContent: vi.fn(async () => '# 章节标题\n\n正文含**强调**、[链接](https://x.y)与`代码`。'),
  },
}))

const { saveFileMock, writeMock, writeBase64Mock } = vi.hoisted(() => ({
  saveFileMock: vi.fn(),
  writeMock: vi.fn(),
  writeBase64Mock: vi.fn(),
}))

beforeEach(() => {
  saveFileMock.mockReset()
  writeMock.mockReset().mockResolvedValue(undefined)
  writeBase64Mock.mockReset().mockResolvedValue(undefined)
  ;(globalThis as any).window = {
    electronAPI: { dialog: { saveFile: saveFileMock }, file: { write: writeMock, writeBase64: writeBase64Mock } },
  }
})

import { exportNovel, exportChapter, exportAsFile, exportNovelDocx, stripMarkdown } from '../export-service'

describe('Export Service', () => {
  it('md 导出保留 Markdown 结构', async () => {
    const md = await exportNovel('n1', { format: 'md' })
    expect(md).toContain('# 测试书')
    expect(md).toContain('## 第一卷')
    expect(md).toContain('### 第1章 · 初见')
    expect(md).toContain('**强调**')
  })

  it('D-T10-2: txt 导出去除 Markdown 标记（format 影响内容生成）', async () => {
    const txt = await exportNovel('n1', { format: 'txt' })
    expect(txt).toContain('《测试书》')
    expect(txt).toContain('简介加粗与斜体')
    expect(txt).toContain('【第一卷】')
    expect(txt).toContain('第1章 · 初见')
    expect(txt).toContain('正文含强调、链接与代码。')
    expect(txt).not.toMatch(/(^|\n)#/)
    expect(txt).not.toContain('**')
    expect(txt).not.toContain('`')
    expect(txt).not.toContain('*(')
  })

  it('stripMarkdown 处理引用/列表/水平线/图片', () => {
    const out = stripMarkdown('> 引用行\n- 列表项\n1. 有序列表\n\n---\n\n![图](a.png)')
    expect(out).toContain('引用行')
    expect(out).toContain('列表项')
    expect(out).toContain('有序列表')
    expect(out).toContain('图')
    expect(out).not.toContain('>')
    expect(out).not.toContain('---')
    expect(out).not.toContain('![')
  })

  it('D-T10-2: exportChapter txt 格式去标记，md 格式保留', async () => {
    const txt = await exportChapter('c1', { format: 'txt' })
    expect(txt).not.toContain('#')
    expect(txt).toContain('正文含强调、链接与代码。')
    const md = await exportChapter('c1')
    expect(md).toContain('# Chapter')
  })

  it('D-T10-1: 用户取消保存对话框时返回 false 且不写盘', async () => {
    saveFileMock.mockResolvedValue('')
    const saved = await exportAsFile('内容', '测试书.md')
    expect(saved).toBe(false)
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('D-T10-1: 选择保存路径时返回 true 并写盘', async () => {
    saveFileMock.mockResolvedValue('C:\\out\\测试书.md')
    const saved = await exportAsFile('内容', '测试书.md', 'txt')
    expect(saved).toBe(true)
    expect(writeMock).toHaveBeenCalledWith('C:\\out\\测试书.md', '内容')
  })

  it('docx 导出走 writeBase64 二进制通道且产物为合法 zip（PK 头）', async () => {
    saveFileMock.mockResolvedValue('C:\\out\\测试书.docx')
    const bytes = await exportNovelDocx('n1', { format: 'docx' })
    expect(bytes.length).toBeGreaterThan(0)
    expect(writeMock).not.toHaveBeenCalled()
    const saved = await exportAsFile(bytes, '测试书.docx', 'docx')
    expect(saved).toBe(true)
    expect(writeBase64Mock).toHaveBeenCalledTimes(1)
    expect(writeBase64Mock.mock.calls[0][0]).toBe('C:\\out\\测试书.docx')
    // base64 解码回原字节，docx 实为 zip（PK\x03\x04 魔数）
    const decoded = Buffer.from(writeBase64Mock.mock.calls[0][1] as string, 'base64')
    expect(decoded.length).toBe(bytes.length)
    expect(decoded[0]).toBe(0x50)
    expect(decoded[1]).toBe(0x4b)
    // 文本内容写盘仍走 write 通道，不误入 writeBase64
    expect(writeBase64Mock.mock.calls[0][1]).not.toBe('内容')
  })

  it('docx：缺正文章节生成占位段且不中断导出', async () => {
    const { chapterService } = await import('../data-service')
    ;(chapterService.loadContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no file'))
    saveFileMock.mockResolvedValue('C:\\out\\测试书.docx')
    const bytes = await exportNovelDocx('n1', { format: 'docx' })
    expect(bytes.length).toBeGreaterThan(0)
    expect(writeBase64Mock).not.toHaveBeenCalled()
    const saved = await exportAsFile(bytes, '测试书.docx', 'docx')
    expect(saved).toBe(true)
    // 落盘内容可解码回同一份字节
    const decoded = Buffer.from(writeBase64Mock.mock.calls[0][1] as string, 'base64')
    expect(decoded.length).toBe(bytes.length)
  })

  it('导出剥离场景边界标记（md/txt 都不外泄注释）', async () => {
    const { chapterService } = await import('../data-service')
    ;(chapterService.loadContent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      '<!-- scene:s1 -->\n\n第一场正文\n\n<!-- scene:s2 -->\n\n第二场正文'
    )
    const md = await exportNovel('n1', { format: 'md' })
    expect(md).not.toContain('<!-- scene:')
    expect(md).toContain('第一场正文')
    expect(md).toContain('第二场正文')
  })

  it('md/txt 导出回归：重构后输出与原实现一致', async () => {
    const md = await exportNovel('n1', { format: 'md' })
    expect(md).toBe('# 测试书\n\n简介**加粗**与*斜体*\n\n---\n\n## 第一卷\n\n### 第1章 · 初见\n\n# 章节标题\n\n正文含**强调**、[链接](https://x.y)与`代码`。\n\n')
    const txt = await exportNovel('n1', { format: 'txt' })
    expect(txt).toBe('《测试书》\n\n简介加粗与斜体\n\n【第一卷】\n\n第1章 · 初见\n\n章节标题\n\n正文含强调、链接与代码。\n\n')
  })
})
