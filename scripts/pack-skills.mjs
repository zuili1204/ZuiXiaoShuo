// 构建期技能包：把 src/skills 下全部 Markdown 加密为单个 .enc 资源。
// 格式：MAGIC(4) + version(1) + iv(12) + tag(16) + AES-256-GCM(gzip(JSON))
// 用法：node scripts/pack-skills.mjs
// 密钥从 ZXS_SKILL_KEY 或 .env.skills.local 读取；密钥文件不入库。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(root, 'src', 'skills')
const OUT_DIR = join(root, 'resources', 'skills')
const OUT = join(OUT_DIR, 'skills.bundle.enc')

// 与 vite.config.ts 使用同一读取规则
function loadSkillKey() {
  const fromEnv = process.env.ZXS_SKILL_KEY?.trim()
  if (fromEnv) return fromEnv
  const keyFile = join(root, '.env.skills.local')
  if (existsSync(keyFile)) {
    const line = readFileSync(keyFile, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.startsWith('ZXS_SKILL_KEY='))
    const value = line?.slice('ZXS_SKILL_KEY='.length).trim()
    if (value) return value
  }
  throw new Error('缺少技能加密密钥：请设置 ZXS_SKILL_KEY，或创建 .env.skills.local')
}

const KEY_SECRET = loadSkillKey()
const MAGIC = Buffer.from('ZXSK')
const VERSION = 1

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const files = {}
let sourceBytes = 0
for (const full of walk(SKILLS_DIR)) {
  const rel = relative(SKILLS_DIR, full).split(sep).join('/')
  const content = readFileSync(full, 'utf8')
  files[rel] = content
  sourceBytes += Buffer.byteLength(content)
}

const payload = gzipSync(Buffer.from(JSON.stringify({ version: VERSION, files }), 'utf8'), { level: 9 })
const key = createHash('sha256').update(KEY_SECRET, 'utf8').digest()
const iv = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
const tag = cipher.getAuthTag()
const bundle = Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, encrypted])

// 回读校验：确保主进程按同一格式能完整解出
{
  const decipher = createDecipheriv('aes-256-gcm', key, bundle.subarray(5, 17))
  decipher.setAuthTag(bundle.subarray(17, 33))
  const decoded = JSON.parse(gunzipSync(Buffer.concat([decipher.update(bundle.subarray(33)), decipher.final()])).toString('utf8'))
  if (Object.keys(decoded.files).length !== Object.keys(files).length) {
    throw new Error('技能包回读校验失败：文件数量不一致')
  }
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, bundle)
console.log(
  `skills.bundle.enc: ${Object.keys(files).length} files, ${(sourceBytes / 1024).toFixed(1)} KB → ${(bundle.length / 1024).toFixed(1)} KB`,
)
