import { useEffect } from 'react'

type ShortcutMap = Record<string, (e: KeyboardEvent) => void>

// 将快捷键字符串解析为匹配函数，例如 "mod+f"、"ctrl+enter"、"escape"
export function matches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needMod = parts.includes('mod') || parts.includes('ctrl') || parts.includes('cmd')
  const needShift = parts.includes('shift')
  const needAlt = parts.includes('alt')

  const mod = e.ctrlKey || e.metaKey
  if (needMod !== mod) return false
  if (needShift !== e.shiftKey) return false
  if (needAlt !== e.altKey) return false

  const pressed = e.key.toLowerCase()
  if (key === 'escape') return pressed === 'escape'
  if (key === 'enter') return pressed === 'enter'
  return pressed === key
}

export function useShortcut(map: ShortcutMap, deps: unknown[] = []) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      for (const combo of Object.keys(map)) {
        if (matches(combo, e)) {
          e.preventDefault()
          map[combo](e)
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
