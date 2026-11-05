// 单测环境没有 Electron 主进程：直接从磁盘注入技能明文，模拟 preload 的 skills.readFile。
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function walk(dir: string, base: string, files: Record<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, files)
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      files[relative(base, full).split(sep).join('/')] = readFileSync(full, 'utf8')
    }
  }
}

const root = join(process.cwd(), 'src', 'skills')
const files: Record<string, string> = {}
walk(root, root, files)

if (Object.keys(files).length === 0) {
  throw new Error('vitest.setup: src/skills 下未找到 Markdown')
}

;(globalThis as { __ZXS_SKILL_FILES__?: Record<string, string> }).__ZXS_SKILL_FILES__ = files
