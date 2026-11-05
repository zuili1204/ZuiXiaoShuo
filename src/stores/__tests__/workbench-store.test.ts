import { describe, it, expect, beforeEach, vi } from 'vitest'

const { getSettingMock, setSettingMock, runQualityGateMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
  runQualityGateMock: vi.fn(),
}))

vi.mock('@/services/settings-service', () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
}))

vi.mock('@/services/quality-service', () => ({
  runQualityGate: runQualityGateMock,
}))

import { useWorkbenchStore } from '../workbench-store'
import type { Chapter, QualityGate } from '@shared/types'

const chapter = (id: string, title = id): Chapter => ({
  id,
  volumeId: 'v1',
  title,
  order: 1,
  contentPath: `content/n1/${id}.md`,
  wordCount: 0,
  targetWordCount: 3000,
  status: 'draft',
  hooks: [],
  summary: '',
  createdAt: '',
  updatedAt: '',
})

const gate = (score: number): QualityGate => ({
  score,
  passed: score >= 60,
  deslopTag: true,
  aiPatternHits: 0,
  degenerationHits: 0,
  checkedAt: '2026-10-21T00:00:00.000Z',
})

describe('workbench-store 布局持久化（P2-8）', () => {
  beforeEach(() => {
    getSettingMock.mockReset()
    setSettingMock.mockReset()
    runQualityGateMock.mockReset()
    useWorkbenchStore.setState({
      leftPanelWidth: 280,
      rightPanelWidth: 380,
      isLeftCollapsed: false,
      isRightCollapsed: false,
      selectedChapter: null,
      editorContent: '',
      aiReportGate: null,
      aiReportChapterId: null,
      aiReportChecking: false,
      aiReportError: null,
    })
  })

  it('hydrateLayout 恢复布局并夹紧宽度范围', async () => {
    getSettingMock.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'layout.leftPanelWidth') return 800
      if (key === 'layout.rightPanelWidth') return 450
      if (key === 'layout.leftCollapsed') return true
      return fallback
    })
    await useWorkbenchStore.getState().hydrateLayout()
    const s = useWorkbenchStore.getState()
    expect(s.leftPanelWidth).toBe(500)
    expect(s.rightPanelWidth).toBe(450)
    expect(s.isLeftCollapsed).toBe(true)
    expect(s.isRightCollapsed).toBe(false)
  })

  it('hydrateLayout 读库失败时保持默认布局', async () => {
    getSettingMock.mockRejectedValue(new Error('db down'))
    await useWorkbenchStore.getState().hydrateLayout()
    const s = useWorkbenchStore.getState()
    expect(s.leftPanelWidth).toBe(280)
    expect(s.isLeftCollapsed).toBe(false)
  })

  it('折叠切换立即落库；宽度变更防抖后落库并夹紧', async () => {
    vi.useFakeTimers()
    try {
      useWorkbenchStore.getState().toggleLeftCollapsed()
      expect(setSettingMock).toHaveBeenCalledWith('layout.leftCollapsed', true)

      useWorkbenchStore.getState().setLeftPanelWidth(360)
      expect(setSettingMock).not.toHaveBeenCalledWith('layout.leftPanelWidth', 360)
      await vi.advanceTimersByTimeAsync(450)
      expect(setSettingMock).toHaveBeenCalledWith('layout.leftPanelWidth', 360)

      useWorkbenchStore.getState().setLeftPanelWidth(9999)
      await vi.advanceTimersByTimeAsync(450)
      expect(setSettingMock).toHaveBeenCalledWith('layout.leftPanelWidth', 500)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('workbench-store AI 率报告（按章节绑定）', () => {
  it('检测结果绑定发起检测的章节，并复位 loading', async () => {
    runQualityGateMock.mockResolvedValue(gate(80))
    useWorkbenchStore.setState({
      selectedChapter: chapter('c1'),
      editorContent: '第一章正文',
    })

    const pending = useWorkbenchStore.getState().runAiReportCheck()
    expect(useWorkbenchStore.getState().aiReportChecking).toBe(true)
    await pending

    const s = useWorkbenchStore.getState()
    expect(runQualityGateMock).toHaveBeenCalledWith('第一章正文')
    expect(s.aiReportGate).toEqual(gate(80))
    expect(s.aiReportChapterId).toBe('c1')
    expect(s.aiReportChecking).toBe(false)
    expect(s.aiReportError).toBeNull()
  })

  it('切章清空旧报告；检测途中返回的旧结果不污染新章节', async () => {
    let resolveGate!: (value: QualityGate) => void
    runQualityGateMock.mockReturnValue(new Promise<QualityGate>((r) => { resolveGate = r }))
    useWorkbenchStore.setState({
      selectedChapter: chapter('c1'),
      editorContent: '第一章正文',
    })

    const pending = useWorkbenchStore.getState().runAiReportCheck()
    useWorkbenchStore.getState().selectChapter(chapter('c2'))
    expect(useWorkbenchStore.getState().aiReportChecking).toBe(false)
    expect(useWorkbenchStore.getState().aiReportGate).toBeNull()

    resolveGate(gate(30))
    await pending
    const s = useWorkbenchStore.getState()
    expect(s.aiReportGate).toBeNull()
    expect(s.aiReportChapterId).toBeNull()
    expect(s.aiReportChecking).toBe(false)
  })

  it('检测失败写入 aiReportError，供抽屉直接展示', async () => {
    runQualityGateMock.mockRejectedValue(new Error('脚本不可用'))
    useWorkbenchStore.setState({
      selectedChapter: chapter('c1'),
      editorContent: '正文',
    })

    await useWorkbenchStore.getState().runAiReportCheck()
    const s = useWorkbenchStore.getState()
    expect(s.aiReportError).toContain('脚本不可用')
    expect(s.aiReportChecking).toBe(false)
    expect(s.aiReportGate).toBeNull()
  })

  it('同一章节的标题更新不清空报告', () => {
    useWorkbenchStore.setState({
      selectedChapter: chapter('c1', '旧标题'),
      aiReportGate: gate(70),
      aiReportChapterId: 'c1',
    })
    useWorkbenchStore.getState().selectChapter(chapter('c1', '新标题'))
    const s = useWorkbenchStore.getState()
    expect(s.selectedChapter?.title).toBe('新标题')
    expect(s.aiReportGate).toEqual(gate(70))
  })
})
