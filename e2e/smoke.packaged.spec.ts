import { test, expect, _electron } from 'playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 安装包冒烟：直接启动 electron-builder 的 win-unpacked 产物（与 NSIS 安装后内容一致）
const packagedExe = join(__dirname, '..', 'release', 'win-unpacked', '醉小说.exe')
const expectedVersion = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
).version as string

test.skip(!existsSync(packagedExe), '尚未构建 release/win-unpacked，跳过安装包冒烟')

test('安装包冒烟：打包产物可启动、版本正确并渲染主页', async () => {
  const appDataDir = mkdtempSync(join(tmpdir(), 'zxs-packaged-'))
  const app = await _electron.launch({
    executablePath: packagedExe,
    env: { ...process.env, ZXS_USER_DATA_DIR: appDataDir },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByText('新建小说').first()).toBeVisible()
    await expect(page.getByText('还没有小说')).toBeVisible()

    const version = await app.evaluate(({ app }) => app.getVersion())
    expect(version).toBe(expectedVersion)

    // 打包后脚本位于 asar：确认子进程能读到 deslop 脚本与文风算法库
    const gate = await page.evaluate(async () => {
      const text = '「你来了。」他低声说。窗外的雨还没有停，桌上的茶已经凉了。' +
        '他抬起头，看了一眼墙上的钟，又低下去继续写。'.repeat(4)
      return await (window as any).electronAPI.quality.check(text)
    })
    expect(Array.isArray(gate.findings)).toBe(true)
    expect(gate.findings.some((f: { source: string }) => f.source === 'style-metrics')).toBe(true)
  } finally {
    await app.close()
    rmSync(appDataDir, { recursive: true, force: true })
  }
})
