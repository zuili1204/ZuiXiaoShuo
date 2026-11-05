import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { ActionLog } from '@/services/log-service'

// 从被点击元素中提取可读的语义描述。
// 优化点：
// 1. 优先 data-log 显式标记（最可靠）
// 2. 只向上冒泡有限层数（3 层），避免抓到「整个卡片」的冗长 innerText
// 3. innerText 截断到 60 字符，并做空值/undefined 过滤
function describeClick(target: EventTarget | null): string | null {
  if (!target || !(target instanceof HTMLElement)) return null
  let el: HTMLElement | null = target
  let depth = 0
  while (el && el !== document.body && depth < 4) {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    const explicit = el.getAttribute('data-log')
    if (explicit) return explicit
    if (tag === 'button' || tag === 'a' || tag === 'input' || role) {
      // 优先 aria-label / title（最语义化），其次 innerText（截断）
      const hint = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim()
      const rawText = (el.innerText || '').trim().replace(/\s+/g, ' ')
      // 防御：过滤 undefined/null 等非正常文本
      const text = (typeof rawText === 'string' ? rawText : '').replace(/undefined/g, '').slice(0, 60)
      const label = hint || text
      if (label && label.length > 0) {
        const where = role ? `[role=${role}]` : tag
        return `${where}: ${label}`
      }
    }
    el = el.parentElement
    depth++
  }
  // 兜底：仅当点击目标本身有简短文本时才记录，避免噪音
  const rawText = (target as HTMLElement).innerText
  const text = (typeof rawText === 'string' ? rawText : '').trim().replace(/\s+/g, ' ').replace(/undefined/g, '').slice(0, 40)
  if (text) return `click: ${text}`
  return null
}

// 全局监听：记录用户每一次鼠标点击
export function useGlobalClickLog() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const desc = describeClick(e.target)
      if (desc) ActionLog.ui('click', desc)
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [])
}

// 全局监听：记录路由（页面）跳转，连续重复的路由不重复记录
export function useRouteLog() {
  const location = useLocation()
  const lastRef = useRef<string>('')
  useEffect(() => {
    const route = location.pathname + location.search
    if (route !== lastRef.current) {
      lastRef.current = route
      ActionLog.nav('route-change', route)
    }
  }, [location.pathname, location.search])
}

// 在 App 顶层挂载全局日志监听
export function useGlobalActionLog() {
  useGlobalClickLog()
  useRouteLog()
}
