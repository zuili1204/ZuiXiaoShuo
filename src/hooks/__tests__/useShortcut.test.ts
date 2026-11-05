import { describe, it, expect } from 'vitest'
import { matches } from '../useShortcut'

function keyEvent(key: string, opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrl || false,
    metaKey: opts.meta || false,
    shiftKey: opts.shift || false,
    altKey: opts.alt || false,
  } as KeyboardEvent
}

describe('useShortcut.matches', () => {
  it('should match mod+f (ctrl or meta)', () => {
    expect(matches('mod+f', keyEvent('f', { ctrl: true }))).toBe(true)
    expect(matches('mod+f', keyEvent('f', { meta: true }))).toBe(true)
    expect(matches('mod+f', keyEvent('f', {}))).toBe(false)
  })

  it('mod+enter should require modifier + Enter', () => {
    expect(matches('mod+enter', keyEvent('Enter', { ctrl: true }))).toBe(true)
    expect(matches('mod+enter', keyEvent('Enter', {}))).toBe(false)
  })

  it('should match escape', () => {
    expect(matches('escape', keyEvent('Escape'))).toBe(true)
    expect(matches('escape', keyEvent('Esc'))).toBe(false)
  })

  it('should respect shift modifier', () => {
    expect(matches('shift+/', keyEvent('/', { shift: true }))).toBe(true)
    expect(matches('shift+/', keyEvent('/', {}))).toBe(false)
  })

  it('should not match when extra modifiers present', () => {
    expect(matches('mod+f', keyEvent('f', { ctrl: true, shift: true }))).toBe(false)
  })
})
