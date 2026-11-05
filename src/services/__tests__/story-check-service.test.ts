import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Character, Chapter, CharacterState } from '@shared/types'

vi.mock('../data-service', () => ({
  characterService: { getByNovelId: vi.fn() },
  foreshadowingService: { getByNovelId: vi.fn() },
  chapterService: { getById: vi.fn() },
}))
vi.mock('../scene-service', () => ({ listSceneCards: vi.fn() }))
vi.mock('../tracking-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tracking-service')>()
  return { ...actual, loadTrackingState: vi.fn() }
})
vi.mock('../story-state-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../story-state-service')>()
  return {
    ...actual,
    ensureStoryStateMigrated: vi.fn(),
    listCharacterStates: vi.fn(),
    listTimelineEvents: vi.fn(),
    listPlotThreads: vi.fn(),
  }
})

import { characterService, chapterService, foreshadowingService } from '../data-service'
import { listSceneCards } from '../scene-service'
import { loadTrackingState } from '../tracking-service'
import {
  ensureStoryStateMigrated,
  listCharacterStates,
  listPlotThreads,
  listTimelineEvents,
} from '../story-state-service'
import { checkChapterContinuity, checkOutputContinuity } from '../story-check-service'
import { createDefaultState } from '../tracking-service'

const character: Character = {
  id: 'char1',
  novelId: 'n1',
  name: '林夕',
  role: 'protagonist',
  profile: '',
  dynamicState: '',
}

const deadState: CharacterState = {
  id: 's1',
  novelId: 'n1',
  characterId: 'char1',
  chapterId: 'c2',
  chapterOrder: 2,
  location: '',
  knowledge: { knows: [], suspects: [], unaware: [] },
  items: [],
  abilities: [],
  relationships: [],
  status: 'dead',
  note: '',
  createdAt: '2026-11-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(characterService.getByNovelId).mockResolvedValue([character])
  vi.mocked(foreshadowingService.getByNovelId).mockResolvedValue([])
  vi.mocked(loadTrackingState).mockResolvedValue(createDefaultState('n1'))
  vi.mocked(ensureStoryStateMigrated).mockResolvedValue({ characterStates: 0, timelineEvents: 0, plotThreads: 0 })
  vi.mocked(listCharacterStates).mockResolvedValue([deadState])
  vi.mocked(listTimelineEvents).mockResolvedValue([])
  vi.mocked(listPlotThreads).mockResolvedValue([])
  vi.mocked(listSceneCards).mockResolvedValue([])
})

describe('checkChapterContinuity', () => {
  it('组装角色/时间线/剧情线并返回确定性 finding', async () => {
    const findings = await checkChapterContinuity({
      novelId: 'n1',
      chapterId: 'c3',
      chapterOrder: 3,
      hooks: [],
      content: '林夕推门而入。',
    })

    expect(ensureStoryStateMigrated).toHaveBeenCalledWith('n1', expect.objectContaining({ currentChapterOrder: 3 }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ ruleId: 'dead-character', severity: 'blocking' })
  })
})

describe('checkOutputContinuity', () => {
  it('只有 chapterId 时自动补齐章序与 hooks', async () => {
    vi.mocked(chapterService.getById).mockResolvedValue({
      id: 'c3',
      title: '第三章',
      order: 3,
      hooks: ['林夕出场'],
    } as Chapter)

    const findings = await checkOutputContinuity({
      novelId: 'n1',
      chapterId: 'c3',
      content: '林夕推门而入。',
    })

    expect(chapterService.getById).toHaveBeenCalledWith('c3')
    expect(findings[0]).toMatchObject({ ruleId: 'dead-character' })
  })

  it('缺少章节信息时返回空数组，不误判', async () => {
    const findings = await checkOutputContinuity({ novelId: 'n1', content: '林夕推门而入。' })
    expect(findings).toEqual([])
  })
})
