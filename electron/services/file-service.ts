import { promises as fs, constants as fsConstants } from 'fs'
import { join, isAbsolute, dirname, basename, relative } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'

export interface ContentMigrationPlan {
  sourceDir: string
  targetDir: string
  /** 已复制到目标目录的绝对路径，失败回滚时逐个删除 */
  copiedFiles: string[]
}

function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isSamePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

function isSubPath(parent: string, child: string): boolean {
  const rel = relative(comparable(parent), comparable(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export class FileService {
  private overrideDir?: string
  // 写操作队列：目录迁移期间到达的写入会等复制完成并切换 baseDir 后再执行，
  // 避免迁移窗口内的自动保存落进旧目录而丢失。
  private writeQueue: Promise<unknown> = Promise.resolve()

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job, job)
    this.writeQueue = run.catch(() => undefined)
    return run
  }

  // 默认数据目录：userData 下的 content 子目录。
  // 惰性读取（getter）：模块加载早于 main 中的 app.setPath 测试钩子，
  // 构造期固化会把 baseDir 指向真实用户目录，导致 E2E 隔离失效。
  private get baseDir(): string {
    return this.overrideDir || join(app.getPath('userData'), 'content')
  }

  // 设置内容根目录（来自 settings 的 dataPath，启动或运行时调用）
  setBaseDir(dir: string) {
    if (dir && dir.trim()) {
      this.overrideDir = dir
    }
  }

  getBaseDir(): string {
    return this.baseDir
  }

  // 相对路径以 baseDir 为根解析；绝对路径原样返回
  private resolve(p: string): string {
    return isAbsolute(p) ? p : join(this.baseDir, p)
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(this.resolve(filePath), 'utf-8')
  }

  // 原子写：先写同目录临时文件再 rename 覆盖，避免进程中断留下半截正文/快照。
  // 同目录保证 rename 不跨卷；失败时清理临时文件，不留残骸。
  private async atomicWrite(full: string, data: string | Buffer): Promise<void> {
    const dir = dirname(full)
    await fs.mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${basename(full)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, full)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    // resolve 放进队列任务：等待迁移结束后按新 baseDir 解析
    await this.exclusive(() => this.atomicWrite(this.resolve(filePath), content))
  }

  // 二进制写入（DOCX 导出等）：IPC 只能传字符串，二进制以 base64 编码过桥
  async writeFileBase64(filePath: string, base64: string): Promise<void> {
    await this.exclusive(() => this.atomicWrite(this.resolve(filePath), Buffer.from(base64, 'base64')))
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  // 递归收集相对路径文件，跳过原子写崩溃遗留的 .tmp
  private async collectFiles(root: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
        throw e
      }
      for (const entry of entries) {
        if (entry.name.endsWith('.tmp')) continue
        const childRel = rel ? join(rel, entry.name) : entry.name
        if (entry.isDirectory()) await walk(join(dir, entry.name), childRel)
        else if (entry.isFile()) out.push(childRel)
      }
    }
    await walk(root, '')
    return out
  }

  // 预检冲突后复制现有内容；不切换 baseDir、不改设置。
  // 目标已有同名文件时整体中止（COPYFILE_EXCL 也不覆盖），避免两套数据互相污染。
  private async copyContent(targetDirRaw: string): Promise<ContentMigrationPlan> {
    const targetDir = targetDirRaw.trim()
    if (!targetDir) throw new Error('目标目录不能为空')
    if (!isAbsolute(targetDir)) throw new Error('目标目录必须是绝对路径')
    const sourceDir = this.baseDir
    if (isSamePath(sourceDir, targetDir)) throw new Error('目标目录与当前内容目录相同')
    if (isSubPath(sourceDir, targetDir) || isSubPath(targetDir, sourceDir)) {
      throw new Error('目标目录不能与当前内容目录互相嵌套')
    }
    try {
      const st = await fs.stat(targetDir)
      if (!st.isDirectory()) throw new Error('目标路径不是目录')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      await fs.mkdir(targetDir, { recursive: true })
    }

    const relFiles = await this.collectFiles(sourceDir)
    const conflicts: string[] = []
    for (const rel of relFiles) {
      if (await this.pathExists(join(targetDir, rel))) conflicts.push(rel)
    }
    if (conflicts.length) {
      const preview = conflicts.slice(0, 5).join('、')
      const more = conflicts.length > 5 ? ` 等 ${conflicts.length} 个` : ''
      throw new Error(`目标目录已存在同名文件（${preview}${more}），已中止迁移且未覆盖。请选择空目录。`)
    }

    const copiedFiles: string[] = []
    try {
      for (const rel of relFiles) {
        const to = join(targetDir, rel)
        await fs.mkdir(dirname(to), { recursive: true })
        await fs.copyFile(join(sourceDir, rel), to, fsConstants.COPYFILE_EXCL)
        copiedFiles.push(to)
      }
    } catch (e) {
      await this.rollbackMigration({ sourceDir, targetDir, copiedFiles })
      throw new Error(`迁移复制失败：${(e as Error).message}`)
    }
    return { sourceDir, targetDir, copiedFiles }
  }

  // 完整迁移：复制 → 落设置（commit）→ 切换 baseDir，全程独占写队列。
  // commit 抛错时回滚本次复制并保持旧目录继续生效。
  async migrateTo(
    targetDirRaw: string,
    commit: (plan: ContentMigrationPlan) => void | Promise<void>,
  ): Promise<ContentMigrationPlan> {
    return this.exclusive(async () => {
      const plan = await this.copyContent(targetDirRaw)
      try {
        await commit(plan)
      } catch (e) {
        await this.rollbackMigration(plan)
        throw e
      }
      this.setBaseDir(plan.targetDir)
      return plan
    })
  }

  // 回滚只删除本次复制过去的文件；源目录与目标原有文件均不动
  async rollbackMigration(plan: ContentMigrationPlan): Promise<void> {
    for (const p of plan.copiedFiles) {
      try {
        await fs.unlink(p)
      } catch {
        /* 已不存在 */
      }
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    await this.exclusive(() => fs.unlink(this.resolve(filePath)))
  }

  // 递归删除目录（快照/知识库等按小说/章节归集的目录）；目录不存在时静默成功
  async deleteDir(dirPath: string): Promise<void> {
    await this.exclusive(() => fs.rm(this.resolve(dirPath), { recursive: true, force: true }))
  }

  // 原子重命名：用于「先写临时文件再覆盖」，避免进程中断留下半截文件
  async renameFile(fromPath: string, toPath: string): Promise<void> {
    await this.exclusive(() => fs.rename(this.resolve(fromPath), this.resolve(toPath)))
  }

  async listFiles(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.resolve(dirPath), { withFileTypes: true })
      // 崩溃遗留的 .tmp 原子写中间文件不对上层暴露
      return entries.filter((e) => e.isFile() && !e.name.endsWith('.tmp')).map((e) => e.name)
    } catch {
      return []
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(filePath))
      return true
    } catch {
      return false
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    await this.exclusive(() => fs.mkdir(this.resolve(dirPath), { recursive: true }))
  }
}

export const fileService = new FileService()
