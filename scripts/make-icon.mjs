// 从选定主图生成 resources/icons/icon.ico（零依赖：内置 zlib 解码 PNG，再打包多尺寸 ICO）
// 用法：node scripts/make-icon-png.mjs [源图路径]
import { inflateSync, deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] ?? join(root, 'assets', 'icon-candidates', 'candidate-1.png')
const OUT = join(root, 'resources', 'icons', 'icon.ico')
const FAVICON = join(root, 'public', 'favicon.png')

// ---------- PNG 解码（8bit，非隔行；支持 RGB / RGBA） ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0, height = 0, colorType = 0, bitDepth = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`暂不支持 bitDepth=${bitDepth} colorType=${colorType} 的 PNG`)
      }
      if (data[12] !== 0) throw new Error('暂不支持隔行扫描 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  const channels = colorType === 6 ? 4 : 3
  const bpp = channels
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * channels)
  const prev = Buffer.alloc(stride)
  let line = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[line++]
    const row = raw.subarray(line, line + stride)
    line += stride
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = row[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) {
        throw new Error(`未知 PNG 行过滤器 ${filter}`)
      }
      out[x] = v & 0xff
    }
    out.copy(prev)
  }

  if (channels === 3) {
    const rgba = Buffer.alloc(width * height * 4, 255)
    for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
      rgba[j] = pixels[i]
      rgba[j + 1] = pixels[i + 1]
      rgba[j + 2] = pixels[i + 2]
    }
    return { width, height, rgba }
  }
  return { width, height, rgba: pixels }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 盒式降采样 ----------
const src = decodePng(readFileSync(SRC))
function downscale(size) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const sy0 = Math.floor((y * src.height) / size)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * src.height) / size))
    for (let x = 0; x < size; x++) {
      const sx0 = Math.floor((x * src.width) / size)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * src.width) / size))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * src.width + sx) * 4
          r += src.rgba[i]
          g += src.rgba[i + 1]
          b += src.rgba[i + 2]
          a += src.rgba[i + 3]
          n++
        }
      }
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// ---------- 组装 ICO（PNG 压缩条目，Vista+ 全支持） ----------
const SIZES = [256, 128, 64, 48, 32, 16]
const pngs = SIZES.map((s) => ({ size: s, data: encodePng(s, s, downscale(s)) }))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(pngs.length, 4)
const entries = []
let offset = 6 + pngs.length * 16
for (const { size, data } of pngs) {
  const e = Buffer.alloc(16)
  e[0] = size >= 256 ? 0 : size
  e[1] = size >= 256 ? 0 : size
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += data.length
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]))
mkdirSync(dirname(FAVICON), { recursive: true })
writeFileSync(FAVICON, encodePng(64, 64, downscale(64)))
console.log(`icon.ico written: ${SIZES.join('/')} px → ${OUT}`)
console.log(`favicon.png written: 64 px → ${FAVICON}`)
