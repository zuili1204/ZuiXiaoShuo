import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hoisted = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => hoisted.userData } }))

import { FileService } from '../../../electron/services/file-service'

let userData: string
let contentDir: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'zxs-fs-'))
  hoisted.userData = userData
  contentDir = join(userData, 'content')
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

const tmpLeftovers = (dir: string) => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('FileService 原子写（tmp → rename）', () => {
  it('写入时自动建目录并落盘，不残留临时文件', async () => {
    const svc = new FileService()
    await svc.writeFile('n1/ch1.md', '第一章正文')
    expect(readFileSync(join(contentDir, 'n1/ch1.md'), 'utf-8')).toBe('第一章正文')
    expect(tmpLeftovers(join(contentDir, 'n1'))).toEqual([])
  })

  it('覆盖已有文件：内容完整替换，不残留旧内容', async () => {
    const svc = new FileService()
    await svc.writeFile('n1/ch1.md', '很长的旧正文'.repeat(100))
    await svc.writeFile('n1/ch1.md', '新')
    expect(readFileSync(join(contentDir, 'n1/ch1.md'), 'utf-8')).toBe('新')
    expect(tmpLeftovers(join(contentDir, 'n1'))).toEqual([])
  })

  it('rename 失败（目标被目录占用）时报错并清理临时文件', async () => {
    const svc = new FileService()
    mkdirSync(join(contentDir, 'blocked'), { recursive: true })
    await expect(svc.writeFile('blocked', '写不进去')).rejects.toThrow()
    expect(tmpLeftovers(contentDir)).toEqual([])
  })

  it('writeFileBase64 原子写入二进制并可原样读回', async () => {
    const svc = new FileService()
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    await svc.writeFileBase64('export/book.docx', bytes.toString('base64'))
    expect(readFileSync(join(contentDir, 'export/book.docx')).equals(bytes)).toBe(true)
    expect(tmpLeftovers(join(contentDir, 'export'))).toEqual([])
  })

  it('listFiles 过滤崩溃遗留的 .tmp 中间文件', async () => {
    const svc = new FileService()
    mkdirSync(join(contentDir, 'snapshots'), { recursive: true })
    writeFileSync(join(contentDir, 'snapshots', '20261021-120000-auto.md'), 'ok')
    writeFileSync(join(contentDir, 'snapshots', '.20261021-120000-auto.md.1.abc.tmp'), 'half')
    expect(await svc.listFiles('snapshots')).toEqual(['20261021-120000-auto.md'])
  })

  it('绝对路径跳过 baseDir 解析，直接原子写入', async () => {
    const svc = new FileService()
    const abs = join(userData, 'outside', 'file.txt')
    await svc.writeFile(abs, 'absolute')
    expect(readFileSync(abs, 'utf-8')).toBe('absolute')
  })
})

describe('FileService 内容目录迁移', () => {
  it('复制现有内容（跳过 .tmp），切换后相对路径在新目录解析，源目录保留', async () => {
    const svc = new FileService()
    await svc.writeFile('content/n1/c1.md', '第一章')
    await svc.writeFile('content/templates/t.json', '{}')
    writeFileSync(join(contentDir, '.stale.tmp'), 'half')

    const target = join(userData, 'moved')
    const commit = vi.fn()
    const plan = await svc.migrateTo(target, commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(plan)
    expect(plan.copiedFiles).toHaveLength(2)
    expect(readFileSync(join(target, 'content/n1/c1.md'), 'utf-8')).toBe('第一章')
    expect(readFileSync(join(target, 'content/templates/t.json'), 'utf-8')).toBe('{}')
    expect(existsSync(join(target, '.stale.tmp'))).toBe(false)

    expect(svc.getBaseDir()).toBe(target)
    expect(await svc.readFile('content/n1/c1.md')).toBe('第一章')
    // 旧目录不删除，留给用户确认后手动清理
    expect(readFileSync(join(contentDir, 'content/n1/c1.md'), 'utf-8')).toBe('第一章')
  })

  it('目标存在同名文件 → 预检整体中止，不覆盖且不复制其他文件', async () => {
    const svc = new FileService()
    await svc.writeFile('content/n1/c1.md', '新版')
    await svc.writeFile('content/n2/c2.md', '另一章')

    const target = join(userData, 'moved')
    mkdirSync(join(target, 'content/n1'), { recursive: true })
    writeFileSync(join(target, 'content/n1/c1.md'), '旧版')

    const commit = vi.fn()
    await expect(svc.migrateTo(target, commit)).rejects.toThrow(/同名文件/)
    expect(commit).not.toHaveBeenCalled()
    expect(readFileSync(join(target, 'content/n1/c1.md'), 'utf-8')).toBe('旧版')
    expect(existsSync(join(target, 'content/n2/c2.md'))).toBe(false)
    expect(svc.getBaseDir()).toBe(contentDir)
  })

  it('拒绝相同目录、相对路径与互相嵌套的目录', async () => {
    const svc = new FileService()
    await expect(svc.migrateTo(contentDir, () => {})).rejects.toThrow(/相同/)
    await expect(svc.migrateTo('relative/dir', () => {})).rejects.toThrow(/绝对路径/)
    await expect(svc.migrateTo(join(contentDir, 'nested'), () => {})).rejects.toThrow(/嵌套/)
    await expect(svc.migrateTo(userData, () => {})).rejects.toThrow(/嵌套/)
  })

  it('目标路径被文件占用时报错', async () => {
    const svc = new FileService()
    const target = join(userData, 'not-a-dir')
    writeFileSync(target, 'file')
    await expect(svc.migrateTo(target, () => {})).rejects.toThrow(/不是目录/)
  })

  it('源目录不存在（全新用户）仍可切换并继续写入', async () => {
    const svc = new FileService()
    const target = join(userData, 'moved')
    const plan = await svc.migrateTo(target, () => {})
    expect(plan.copiedFiles).toEqual([])
    expect(existsSync(target)).toBe(true)

    await svc.writeFile('content/n1/c1.md', '新书')
    expect(readFileSync(join(target, 'content/n1/c1.md'), 'utf-8')).toBe('新书')
  })

  it('落设置失败（commit 抛错）→ 回滚复制且保持旧目录生效', async () => {
    const svc = new FileService()
    await svc.writeFile('content/n1/c1.md', '第一章')
    await svc.writeFile('content/n2/c2.md', '第二章')
    const target = join(userData, 'moved')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep.txt'), '原有')

    await expect(
      svc.migrateTo(target, () => {
        throw new Error('db down')
      }),
    ).rejects.toThrow('db down')
    expect(existsSync(join(target, 'content/n1/c1.md'))).toBe(false)
    expect(existsSync(join(target, 'content/n2/c2.md'))).toBe(false)
    expect(readFileSync(join(target, 'keep.txt'), 'utf-8')).toBe('原有')
    expect(svc.getBaseDir()).toBe(contentDir)
  })

  it('迁移期间排队写入：迁移完成后按新目录落盘', async () => {
    const svc = new FileService()
    await svc.writeFile('content/n1/c1.md', '旧章')
    const target = join(userData, 'moved')

    let releaseCommit!: () => void
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const migration = svc.migrateTo(target, () => commitGate)
    // 迁移进行中发起的写入必须等迁移结束
    await new Promise((r) => setTimeout(r, 0))
    const write = svc.writeFile('content/n1/c1.md', '迁移中自动保存')
    releaseCommit()
    await Promise.all([migration, write])

    expect(svc.getBaseDir()).toBe(target)
    expect(readFileSync(join(target, 'content/n1/c1.md'), 'utf-8')).toBe('迁移中自动保存')
  })
})
