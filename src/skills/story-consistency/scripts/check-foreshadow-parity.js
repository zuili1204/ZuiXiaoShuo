#!/usr/bin/env node
/**
 * 伏笔埋设/回收对账（一致性确定性校验）
 * 用法：node scripts/check-foreshadow-parity.js <chaptersDir>
 * 扫描各章中以 [F-xx] 标记的伏笔，区分「埋设」与「回收」，输出悬空与错配。
 */
const fs = require('fs')
const path = require('path')

function scan(dir) {
  const planted = {} // F-id -> 首次出现章
  const resolved = {} // F-id -> 回收章
  if (!fs.existsSync(dir)) return { planted, resolved }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
  files.sort()
  for (const f of files) {
    const chapter = path.basename(f)
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const plantRe = /\[F-([\w-]+)\s*[:：]?\s*埋设\]/g
    const resRe = /\[F-([\w-]+)\s*[:：]?\s*回收\]/g
    let m
    while ((m = plantRe.exec(text))) {
      if (!planted[m[1]]) planted[m[1]] = chapter
    }
    while ((m = resRe.exec(text))) {
      resolved[m[1]] = chapter
    }
  }
  return { planted, resolved }
}

function main() {
  const dir = process.argv[2] || '.'
  const { planted, resolved } = scan(dir)
  const dangling = Object.keys(planted).filter((id) => !resolved[id])
  const earlyResolve = Object.keys(resolved).filter((id) => planted[id] && resolved[id] === planted[id])
  console.log('伏笔埋设数：', Object.keys(planted).length)
  console.log('伏笔回收数：', Object.keys(resolved).length)
  console.log('悬空未回收：', dangling.length ? dangling.join(', ') : '无')
  console.log('同章即收（可疑）：', earlyResolve.length ? earlyResolve.join(', ') : '无')
  if (dangling.length || earlyResolve.length) process.exit(1)
}

main()
