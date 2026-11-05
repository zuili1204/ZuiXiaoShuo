// 技能内容保险库：开发态读明文，打包态解密 .enc；渲染层只能通过 IPC 按文件键读取。
import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { createDecipheriv, createHash } from 'crypto'
import { gunzipSync } from 'zlib'

const MAGIC = Buffer.from('ZXSK')
const VERSION = 1
const BUNDLE_NAME = 'skills.bundle.enc'

// Vite 构建时把 __ZXS_SKILL_KEY__ 替换为字面量；密钥不写入源码。
function getSecret(): string {
  const secret = typeof __ZXS_SKILL_KEY__ === 'string' ? __ZXS_SKILL_KEY__ : ''
  if (!secret) throw new Error('技能包密钥未注入，请检查 ZXS_SKILL_KEY 或 .env.skills.local')
  return secret
}

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

class SkillVault {
  private files: Record<string, string> | null = null
  private source: 'bundle' | 'plaintext' | 'none' = 'none'

  load(verbose = true): void {
    if (this.files) return
    try {
      if (this.shouldUseBundle()) {
        this.files = this.loadBundle()
        this.source = 'bundle'
      } else {
        this.files = walkMarkdown(join(app.getAppPath(), 'src', 'skills'))
        this.source = 'plaintext'
      }
      if (verbose) {
        console.log(`[skills] ${Object.keys(this.files).length} files loaded from ${this.source}`)
      }
    } catch (e) {
      console.error(`[skills] failed to load skill content (${this.source}):`, e)
      this.files = {}
      this.source = 'none'
    }
  }

  read(relKey: string): string | null {
    this.load()
    const key = normalizeKey(relKey)
    return key ? this.files?.[key] ?? null : null
  }

  getSource(): string {
    this.load(false)
    return this.source
  }

  private shouldUseBundle(): boolean {
    const forced = process.env.ZXS_SKILL_SOURCE
    if (forced === 'bundle') return true
    if (forced === 'plaintext') return false
    return app.isPackaged
  }

  private loadBundle(): Record<string, string> {
    const bundlePath = [
      join(process.resourcesPath, 'skills', BUNDLE_NAME),
      join(app.getAppPath(), 'resources', 'skills', BUNDLE_NAME),
    ].find((path) => existsSync(path))
    if (!bundlePath) throw new Error('未找到 skills.bundle.enc，请先运行 npm run pack:skills')

    const buf = readFileSync(bundlePath)
    if (buf.length < 33 || !buf.subarray(0, 4).equals(MAGIC)) {
      throw new Error('技能包格式无效')
    }
    if (buf[4] !== VERSION) throw new Error(`不支持的技能包版本 ${buf[4]}`)

    const key = createHash('sha256').update(getSecret(), 'utf8').digest()
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(5, 17))
    decipher.setAuthTag(buf.subarray(17, 33))
    const json = gunzipSync(
      Buffer.concat([decipher.update(buf.subarray(33)), decipher.final()]),
    ).toString('utf8')
    const parsed = JSON.parse(json) as { files?: Record<string, string> }
    if (!parsed.files || typeof parsed.files !== 'object') throw new Error('技能包内容无效')
    return parsed.files
  }
}

export const skillVault = new SkillVault()
