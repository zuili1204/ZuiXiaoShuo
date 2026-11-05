import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock window.electronAPI.file 以隔离磁盘写
// 注意：rag-service 的原子落盘流程为 write(tmp) → read(tmp) 校验 → rename(tmp, final)
// （见 rag-service.ts:83-87），因此 rename 必须提供，否则落盘抛错、旧 chunk 不被替换。
beforeEach(() => {
  ;(globalThis as any).window = {
    electronAPI: {
      file: {
        read: vi.fn().mockResolvedValue('{}'),
        write: vi.fn().mockResolvedValue(undefined),
        exists: vi.fn().mockResolvedValue(false),
        rename: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
    },
  }
})

import { indexChapterContent, search, clearIndex, getChunks, reindexCharacter, removeCharacterIndex, reindexWorldview, removeWorldviewIndex } from '../rag-service'
import type { Character, Worldview } from '@shared/types'

describe('RAG Service', () => {
  beforeEach(() => {
    clearIndex('n1')
  })

  it('should split chapter content into chunks by paragraphs', () => {
    const content = '第一段内容。\n\n第二段内容。\n\n第三段内容。'
    indexChapterContent('n1', 'c1', '第一章', content, 1)
    const results = search('第一段', 'n1', 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].sourceId).toBe('c1')
  })

  // 注意：检索采用中文 bigram 分词（rag-service.ts:103-112），查询与文本只要共享任意 2 字即计分。
  // 因此本用例的新旧文案 bigram 必须完全不重叠——若沿用「旧内容 / 新内容」，二者共享 bigram
  // 「内容」，旧内容被替换后仍会被「新内容」的 chunk 命中，造成误报。
  it('should replace existing chapter chunks on re-index', () => {
    indexChapterContent('n1', 'c1', '第一章', '秋风扫落叶满阶。\n\n寒鸦栖古枝惊梦。', 1)
    indexChapterContent('n1', 'c1', '第一章', '春风拂柳岸生烟。\n\n暖日照新荷翻翠。', 1)
    const oldHits = search('秋风扫叶', 'n1', 10)
    const newHits = search('春风拂柳', 'n1', 10)
    expect(oldHits.length).toBe(0)
    expect(newHits.length).toBeGreaterThan(0)
  })

  it('should return relevant chunks ranked by token overlap', () => {
    indexChapterContent('n1', 'c1', '第一章', '剑客在竹林中挥剑。\n\n书生在灯下读书。', 1)
    indexChapterContent('n1', 'c2', '第二章', '剑客在山顶迎风而立。\n\n农夫在田间劳作。', 2)
    const results = search('剑客 挥剑', 'n1', 5)
    expect(results.length).toBeGreaterThan(0)
    // 第一章更相关（含「剑客」与「挥剑」）
    expect(results[0].sourceId).toBe('c1')
  })
})

describe('RAG 资产级增量索引（P2-10）', () => {
  beforeEach(() => {
    clearIndex('n1')
  })

  const baseChar: Character = {
    id: 'ch1', novelId: 'n1', name: '林晚晴', role: 'protagonist', gender: 'female',
    age: '18', personality: '冷静沉著善谋划', appearance: '', profile: '', dynamicState: '',
  }

  it('reindexCharacter 单条 upsert：更新档案后旧内容不再命中', () => {
    reindexCharacter('n1', baseChar)
    expect(getChunks('n1').filter((c) => c.type === 'character')).toHaveLength(1)
    expect(search('林晚晴', 'n1', 5).length).toBeGreaterThan(0)

    reindexCharacter('n1', { ...baseChar, personality: '热情张扬爱冒险' })
    expect(getChunks('n1').filter((c) => c.type === 'character')).toHaveLength(1)
    expect(search('冷静沉著', 'n1', 5)).toHaveLength(0)
    expect(search('热情张扬', 'n1', 5).length).toBeGreaterThan(0)
  })

  it('removeCharacterIndex 删除角色分块', () => {
    reindexCharacter('n1', baseChar)
    removeCharacterIndex('n1', 'ch1')
    expect(getChunks('n1').filter((c) => c.type === 'character')).toHaveLength(0)
    expect(search('林晚晴', 'n1', 5)).toHaveLength(0)
  })

  it('reindexWorldview 单条 upsert，删除后不命中', () => {
    const wv: Worldview = { id: 'wv1', novelId: 'n1', category: 'power', title: '灵潮体系', content: '灵气潮汐驱动万物。' }
    reindexWorldview('n1', wv)
    expect(getChunks('n1').filter((c) => c.type === 'worldview')).toHaveLength(1)
    expect(search('灵气潮汐', 'n1', 5).length).toBeGreaterThan(0)

    reindexWorldview('n1', { ...wv, content: '星轨罗盘推演命途。' })
    expect(getChunks('n1').filter((c) => c.type === 'worldview')).toHaveLength(1)
    expect(search('灵气潮汐', 'n1', 5)).toHaveLength(0)
    expect(search('星轨罗盘', 'n1', 5).length).toBeGreaterThan(0)

    removeWorldviewIndex('n1', 'wv1')
    expect(search('星轨罗盘', 'n1', 5)).toHaveLength(0)
  })
})
