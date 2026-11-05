import { describe, it, expect } from 'vitest'
import { parseTextFile } from '../import-service'

describe('Import Service', () => {
  it('观察项-角色去噪：「周文远在/周文远说」不再混入，长短名归并到「周文远」且计数不分裂', () => {
    const content =
      '周文远在窗前。周文远说：「走吧。」文远笑了笑。周文远走了。周文远望向远方。'
    const result = parseTextFile(content, '周文远测试.txt')
    const names = result.characters

    // 无贪心噪声（旧版会抽出「周文远在」「周文远说」等 4 字伪名）
    expect(names.find((n) => n.name === '周文远在')).toBeUndefined()
    expect(names.find((n) => n.name === '周文远说')).toBeUndefined()
    expect(names.find((n) => n.name === '文远在')).toBeUndefined()
    // 子串候选（周文/文远）归并进长名，不作为独立条目分裂计数
    expect(names.find((n) => n.name === '文远')).toBeUndefined()
    expect(names.find((n) => n.name === '周文')).toBeUndefined()

    const found = names.find((n) => n.name === '周文远')
    expect(found).toBeDefined()
    // 周文远×4（在/说/走了/望向 前）+ 文远×4（前三处 trim + 「文远笑了笑」）归并 → 合计 8
    expect(found!.appearances).toBe(8)
  })

  it('观察项-复姓：复姓开头的 3-4 字窗口正常识别，不拆成单姓短名', () => {
    const content =
      '欧阳明月站在山顶。欧阳明月看着远方。欧阳明月笑而不语。'
    const result = parseTextFile(content, '复姓测试.txt')
    const names = result.characters

    expect(names.find((n) => n.name === '欧阳明月')).toBeDefined()
    expect(names.find((n) => n.name === '欧阳')).toBeUndefined()
  })

  it('观察项-简介去 MD：描述不含标题/强调/链接/行内代码标记', () => {
    const content = [
      '# 示例长篇',
      '',
      '这是**强调**的简介，含 [链接](https://x.y) 与 `代码`。',
      '',
      '> 引用行',
    ].join('\n')
    const result = parseTextFile(content, 'md简介测试.md')
    expect(result.description).not.toMatch(/#|\*\*|\]\(|`|^>/)
    expect(result.description).toContain('这是强调的简介')
  })

  it('分章与卷分组回归：第X章切分、字数统计、卷内序号重排', () => {
    const chapter = (i: number) => `第${i}章\n\n${'甲'.repeat(120 + i)}\n`
    const content = [chapter(1), chapter(2), chapter(3)].join('\n')
    const result = parseTextFile(content, '测试书.txt')

    expect(result.title).toBe('测试书')
    expect(result.volumes).toHaveLength(1)
    expect(result.volumes[0].chapters).toHaveLength(3)
    expect(result.volumes[0].chapters.map((c) => c.order)).toEqual([1, 2, 3])
    expect(result.totalWordCount).toBe(content.length)
  })
})
