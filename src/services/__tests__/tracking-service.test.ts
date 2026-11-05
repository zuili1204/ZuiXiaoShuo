import { describe, it, expect, beforeEach } from 'vitest'
import { commitChapter, createDefaultState, generateStateCard } from '../tracking-service'

describe('Tracking Service', () => {
  it('should commit a chapter and accumulate word count', () => {
    const state = createDefaultState('n1')
    const next = commitChapter(state, {
      chapterId: 'c1',
      chapterTitle: '第一章',
      summary: '开局',
      wordCount: 1200,
      keyEvents: ['事件A'],
      charactersInvolved: ['主角'],
      newForeshadowings: ['伏笔1'],
      resolvedForeshadowings: [],
      plotQuestions: ['疑问?'],
    })
    expect(next.committedChapters.length).toBe(1)
    expect(next.totalWordCount).toBe(1200)
    expect(next.activeForeshadowings.length).toBe(1)
    expect(next.activeForeshadowings[0].status).toBe('planted')
  })

  it('should mark existing foreshadowing as resolved', () => {
    const state = createDefaultState('n1')
    const withFs = commitChapter(state, {
      chapterId: 'c1', chapterTitle: '第一章', summary: '', wordCount: 100,
      keyEvents: [], charactersInvolved: [], newForeshadowings: ['伏笔X'], resolvedForeshadowings: [], plotQuestions: [],
    })
    const fsId = withFs.activeForeshadowings[0].id
    const next = commitChapter(withFs, {
      chapterId: 'c2', chapterTitle: '第二章', summary: '', wordCount: 100,
      keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: ['伏笔X'], plotQuestions: [],
    })
    const fs = next.activeForeshadowings.find((f) => f.id === fsId)
    expect(fs?.status).toBe('resolved')
  })

  it('should update word count on re-commit of same chapter', () => {
    const state = createDefaultState('n1')
    const c1 = commitChapter(state, {
      chapterId: 'c1', chapterTitle: '第一章', summary: '', wordCount: 100,
      keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: [], plotQuestions: [],
    })
    const c2 = commitChapter(c1, {
      chapterId: 'c1', chapterTitle: '第一章', summary: '', wordCount: 300,
      keyEvents: [], charactersInvolved: [], newForeshadowings: [], resolvedForeshadowings: [], plotQuestions: [],
    })
    expect(c2.committedChapters.length).toBe(1)
    expect(c2.totalWordCount).toBe(300)
  })

  it('D-T5-2: 重复 commit 同章不产生重复伏笔，同批重复内容也去重', () => {
    const state = createDefaultState('n1')
    const input = {
      chapterId: 'c1', chapterTitle: '第一章', summary: '', wordCount: 100,
      keyEvents: [], charactersInvolved: ['主角'],
      newForeshadowings: ['伏笔1', '伏笔1', '伏笔2'],
      resolvedForeshadowings: [], plotQuestions: [],
    }
    const once = commitChapter(state, input)
    expect(once.activeForeshadowings.filter((f) => f.content === '伏笔1')).toHaveLength(1)
    const twice = commitChapter(once, input)
    expect(twice.activeForeshadowings).toHaveLength(2)
    // 角色出场章节同样幂等：同章重复 commit 不重复累计
    expect(twice.characterInvolvements['主角']).toEqual(['第一章'])
  })

  it('D-T5-1: 状态卡优先显示书名，未传书名时回退 novelId', () => {
    const state = createDefaultState('n1')
    expect(generateStateCard(state, '示例长篇').split('\n')[0]).toBe('小说: 示例长篇')
    expect(generateStateCard(state).split('\n')[0]).toBe('小说: n1')
  })
})
