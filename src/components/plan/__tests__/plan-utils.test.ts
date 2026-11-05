import { describe, it, expect } from 'vitest'
import {
  allChapters,
  chapterDot,
  checklistPercent,
  computePlanChecklist,
  emptySeedForm,
  flatChapters,
  isPlanReady,
  missingHooksCount,
  seedCharactersText,
  seedFormFrom,
  seedOutlineFrom,
} from '../plan-utils'

const chapter = (patch: Record<string, unknown>) =>
  ({
    id: 'c',
    volumeId: 'v1',
    title: '章',
    order: 1,
    contentPath: '',
    wordCount: 0,
    status: 'draft',
    targetWordCount: 3000,
    hooks: [],
    summary: '',
    createdAt: '',
    updatedAt: '',
    ...patch,
  }) as any

const volume = (patch: Record<string, unknown>, chapters: any[]) =>
  ({
    vol: {
      id: 'v1',
      novelId: 'n1',
      title: '第一卷',
      order: 1,
      summary: '',
      ...patch,
    },
    chapters,
  }) as any

describe('plan-utils · 缺细纲口径与状态点', () => {
  it('缺细纲只认 hooks：摘要不算，已写章不算', () => {
    const vols = [
      volume({}, [
        chapter({ id: 'a', hooks: ['钩'] }),
        chapter({ id: 'b', summary: '有摘要无细纲' }),
        chapter({ id: 'c', wordCount: 3200, summary: '已写' }),
      ]),
    ]
    expect(missingHooksCount(vols)).toBe(1)
  })

  it('状态点：已写 > 有细纲 > 空；仅有摘要仍算空', () => {
    expect(chapterDot(chapter({ wordCount: 10, hooks: [] }))).toBe('written')
    expect(chapterDot(chapter({ hooks: ['钩'] }))).toBe('planned')
    expect(chapterDot(chapter({ summary: '只有摘要' }))).toBe('empty')
    expect(chapterDot(chapter({}))).toBe('empty')
  })
})

describe('plan-utils · 完成度清单', () => {
  it('主线/卷纲/首卷章纲/细纲/角色齐备时 100% 且可开写', () => {
    const vols = [
      volume({ summary: '卷纲' }, [
        chapter({ id: 'a', hooks: ['钩'] }),
        chapter({ id: 'b', hooks: ['钩'] }),
      ]),
    ]
    const novel = { id: 'n1', title: '书', masterOutline: '主线' } as any
    const checklist = computePlanChecklist(novel, vols, [{ id: 'p1', name: '主角' } as any])
    expect(checklistPercent(checklist)).toBe(100)
    expect(isPlanReady(checklist)).toBe(true)
  })

  it('有未写章缺细纲时清单未完成，并给出缺章提示', () => {
    const vols = [volume({ summary: '卷纲' }, [chapter({ id: 'a' })])]
    const novel = { id: 'n1', title: '书', masterOutline: '主线' } as any
    const checklist = computePlanChecklist(novel, vols, [{ id: 'p1', name: '主角' } as any])
    const hooksItem = checklist.find((i) => i.key === 'hooks')!
    expect(hooksItem.done).toBe(false)
    expect(hooksItem.hint).toContain('1 章')
    expect(isPlanReady(checklist)).toBe(false)
  })
})

describe('plan-utils · 扁平章序', () => {
  it('按卷顺序展开并带上卷信息', () => {
    const vols = [
      volume({ id: 'v1', title: '卷一' }, [chapter({ id: 'a', order: 1 }), chapter({ id: 'b', order: 2 })]),
      volume({ id: 'v2', title: '卷二', order: 2 }, [chapter({ id: 'c', order: 1, volumeId: 'v2' })]),
    ]
    expect(allChapters(vols).map((c) => c.id)).toEqual(['a', 'b', 'c'])
    const flat = flatChapters(vols)
    expect(flat.map((x) => x.chapter.id)).toEqual(['a', 'b', 'c'])
    expect(flat[2]).toMatchObject({ volumeId: 'v2', volumeTitle: '卷二' })
  })
})

const character = (patch: Record<string, unknown>) =>
  ({
    id: 'p1',
    novelId: 'n1',
    name: '角色',
    role: 'supporting',
    profile: '',
    dynamicState: '',
    ...patch,
  }) as any

describe('plan-utils · 创作线索表单', () => {
  it('seedFormFrom 把主角拆到「主角」块，其余角色进「其他角色」并带身份标签', () => {
    const novel = {
      id: 'n1',
      title: '雾港',
      description: '一句话',
      genre: ['悬疑', '奇幻'],
    } as any
    const form = seedFormFrom(novel, [
      character({ id: 'p1', role: 'protagonist', name: '林默', profile: '记忆侦探' }),
      character({ id: 'a1', role: 'antagonist', name: '白鸦', profile: '典当行老板' }),
      character({ id: 's1', role: 'supporting', name: '小满' }),
    ])
    expect(form.genre).toBe('悬疑 / 奇幻')
    expect(form.title).toBe('雾港')
    expect(form.premise).toBe('一句话')
    expect(form.protagonist).toBe('林默 —— 记忆侦探')
    expect(form.characters.split('\n')).toEqual(['白鸦（反派） —— 典当行老板', '小满（配角）'])
    expect(form.draft).toBe('')
  })

  it('没有主角角色时全部进「其他角色」', () => {
    const form = seedFormFrom({ id: 'n1', title: '书', genre: [] } as any, [
      character({ name: '甲', role: 'supporting' }),
    ])
    expect(form.protagonist).toBe('')
    expect(form.characters).toBe('甲（配角）')
  })

  it('seedCharactersText 合并主角与其他角色并去掉空行', () => {
    const form = { ...emptySeedForm(), protagonist: '  林默  ', characters: ' 白鸦（反派）\n' }
    expect(seedCharactersText(form)).toBe('林默\n白鸦（反派）')
    expect(seedCharactersText(emptySeedForm())).toBe('')
  })

  it('seedOutlineFrom 空字段不传，数字字段按正数解析', () => {
    const form = {
      ...emptySeedForm(),
      title: '  雾港  ',
      draft: '随手记：雾会吞记忆',
      worldview: '   ',
      volCount: ' 3 ',
      chCount: '0',
    }
    expect(seedOutlineFrom(form)).toEqual({
      title: '雾港',
      genre: undefined,
      premise: undefined,
      coreConflict: undefined,
      protagonist: undefined,
      characters: undefined,
      worldview: undefined,
      setting: undefined,
      power: undefined,
      sellingPoints: undefined,
      tone: undefined,
      references: undefined,
      taboos: undefined,
      draft: '随手记：雾会吞记忆',
      volumeCount: 3,
      chapterCount: undefined,
    })
  })
})
