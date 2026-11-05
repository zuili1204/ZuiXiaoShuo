// 技能内容读取：开发态与打包态都从应用目录下的 src/skills 读取明文。
import { app } from 'electron'
import { readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'

function normalizeKey(key: string): string | null {
  const normalized = String(key ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return null
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null
  return normalized
}

function walkMarkdown(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, walkMarkdown(full, base))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files[relative(base, full).split(sep).join('/')] = readFileSync(full, 'utf8')
    }
  }
  return files
}

class SkillContent {
  private files: Record<string, string> | null = null

  load(verbose = true): void {
    if (this.files) return
    try {
      this.files = walkMarkdown(join(app.getAppPath(), 'src', 'skills'))
      if (verbose) console.log(`[skills] ${Object.keys(this.files).length} files loaded`)
    } catch (e) {
      console.error('[skills] failed to load skill content:', e)
      this.files = {}
    }
  }

  read(relKey: string): string | null {
    this.load()
    const key = normalizeKey(relKey)
    return key ? this.files?.[key] ?? null : null
  }
}

export const skillContent = new SkillContent()
