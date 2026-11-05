/**
 * 连贯性检查的编排层：负责取数、懒迁移，再把纯规则交给 continuity-checker。
 * 编辑器抽屉、保存提示、流水线门禁共用这一入口。
 */
import type { Chapter } from '@shared/types'
import { chapterService, characterService, foreshadowingService } from './data-service'
import { listSceneCards } from './scene-service'
import {
  ensureStoryStateMigrated,
  listCharacterStates,
  listPlotThreads,
  listTimelineEvents,
} from './story-state-service'
import { runContinuityCheck, type ContinuityFinding } from './continuity-checker'
import { loadTrackingState } from './tracking-service'

export interface ChapterContinuityParams {
  novelId: string
  chapterId: string
  chapterOrder: number
  hooks?: string[]
  content: string
}

export async function checkChapterContinuity(
  params: ChapterContinuityParams
): Promise<ContinuityFinding[]> {
  const [characters, foreshadowings, tracking] = await Promise.all([
    characterService.getByNovelId(params.novelId),
    foreshadowingService.getByNovelId(params.novelId),
    loadTrackingState(params.novelId),
  ])

  await ensureStoryStateMigrated(params.novelId, {
    characters,
    foreshadowings,
    currentChapterOrder: params.chapterOrder,
  })

  const [characterStates, timelineEvents, plotThreads, sceneCards] = await Promise.all([
    listCharacterStates(params.novelId),
    listTimelineEvents(params.novelId),
    listPlotThreads(params.novelId),
    params.chapterId ? listSceneCards(params.chapterId) : Promise.resolve([]),
  ])

  return runContinuityCheck({
    chapterOrder: params.chapterOrder,
    content: params.content,
    characterStates,
    timelineEvents,
    plotThreads,
    sceneCards,
    hooks: params.hooks ?? [],
    previousPromises: tracking.nextChapterPromises ?? [],
    characterNames: characters.map((c) => c.name),
    characterNamesById: Object.fromEntries(characters.map((c) => [c.id, c.name])),
  })
}

export interface OutputContinuityParams {
  novelId: string
  chapter?: Chapter | null
  chapterId?: string
  chapterOrder?: number
  hooks?: string[]
  content: string
}

/** 流水线/保存场景：只有章节 id 时自动补齐章序与 hooks。 */
export async function checkOutputContinuity(
  params: OutputContinuityParams
): Promise<ContinuityFinding[]> {
  let chapter = params.chapter ?? null
  if (!chapter && params.chapterId) {
    chapter = await chapterService.getById(params.chapterId)
  }
  const chapterOrder = chapter?.order ?? params.chapterOrder
  const chapterId = chapter?.id ?? params.chapterId
  if (!chapterOrder || !chapterId) return []
  return checkChapterContinuity({
    novelId: params.novelId,
    chapterId,
    chapterOrder,
    hooks: chapter?.hooks ?? params.hooks ?? [],
    content: params.content,
  })
}

export function blockingFindings(findings: ContinuityFinding[]): ContinuityFinding[] {
  return findings.filter((f) => f.severity === 'blocking')
}

export function findingSummary(findings: ContinuityFinding[], limit = 3): string {
  return findings
    .slice(0, limit)
    .map((f) => f.message)
    .join('；')
}
