import { describe, it, expect } from 'vitest'
import {
  extractSceneContent,
  insertSceneMarkersAtParagraphs,
  removeSceneMarker,
  replaceSceneContent,
  sceneMarker,
  splitSceneSegments,
  stripSceneMarkers,
} from '../../../shared/scene-marker'

describe('场景正文标记', () => {
  const text = `开场白\n\n${sceneMarker('s1')}\n\n第一场正文\n\n${sceneMarker('s2')}\n\n第二场正文`

  it('分割出开场白与两个场景', () => {
    const segments = splitSceneSegments(text)
    expect(segments.map((s) => s.sceneId)).toEqual([null, 's1', 's2'])
    expect(segments[1].text.trim()).toBe('第一场正文')
    expect(segments[2].text.trim()).toBe('第二场正文')
  })

  it('抽取单场景正文', () => {
    expect(extractSceneContent(text, 's1')?.trim()).toBe('第一场正文')
    expect(extractSceneContent(text, 'missing')).toBeNull()
  })

  it('只替换目标场景，其他场景与原开场白不变', () => {
    const next = replaceSceneContent(text, 's1', '改后的第一场')
    expect(next).not.toBeNull()
    expect(next).toContain('开场白')
    expect(next).toContain('改后的第一场')
    expect(next).toContain('第二场正文')
    expect(next).not.toContain('第一场正文')
  })

  it('导出剥离标记', () => {
    expect(stripSceneMarkers(text)).not.toContain('<!-- scene:')
  })

  it('为已有正文按段落均分插入标记', () => {
    const body = ['甲', '乙', '丙', '丁'].join('\n\n')
    const result = insertSceneMarkersAtParagraphs(body, ['s1', 's2'])
    expect(result.indexOf(sceneMarker('s1'))).toBe(0)
    expect(result.indexOf(sceneMarker('s2'))).toBeGreaterThan(result.indexOf('乙'))
    expect(extractSceneContent(result, 's1')).toContain('甲')
    expect(extractSceneContent(result, 's2')).toContain('丙')
  })

  it('已有标记时不重复插入', () => {
    expect(insertSceneMarkersAtParagraphs(text, ['s3'])).toBe(text)
  })

  it('删卡可移除单个标记并保留正文', () => {
    const next = removeSceneMarker(text, 's1')
    expect(next).not.toContain(sceneMarker('s1'))
    expect(next).toContain('第一场正文')
    expect(next).toContain(sceneMarker('s2'))
  })
})
