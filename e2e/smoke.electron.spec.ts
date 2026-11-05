import { test, expect, _electron, type ElectronApplication, type Page } from 'playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')

test.describe.configure({ mode: 'serial' })

let electronApp: ElectronApplication
let page: Page
let appDataDir: string

test.beforeAll(async () => {
  // 用独立 userData 目录启动（主进程 ZXS_USER_DATA_DIR 钩子）→ 全新空库，不污染真实用户数据。
  // 注意：Electron 在 Windows 上取 appData 走系统 API，APPDATA 环境变量不可靠，需应用内钩子。
  appDataDir = mkdtempSync(join(tmpdir(), 'zxs-e2e-'))
  electronApp = await _electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: { ...process.env, ZXS_USER_DATA_DIR: appDataDir },
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await electronApp.close()
})

test('启动冒烟：主窗口加载并渲染主页空态', async () => {
  await expect(page.getByText('新建小说').first()).toBeVisible()
  await expect(page.getByText('还没有小说')).toBeVisible()
})

test('创建小说 → 进入工作台', async () => {
  await page.getByRole('button', { name: '创建第一部小说' }).click()
  await page.getByPlaceholder('输入小说名称...').fill('E2E测试之书')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  // 应用行为：创建后停留在主页，点击作品卡进入工作台
  await page.getByRole('heading', { name: 'E2E测试之书' }).first().click()
  await page.waitForURL(/#\/workbench\//)
  await expect(page.getByText('章节目录', { exact: true })).toBeVisible()
})

test('新建卷与章节，编辑器写入正文', async () => {
  // 空树 → 创建第一卷（内联输入自动聚焦，默认名「第1卷」）
  await page.getByRole('button', { name: '创建第一卷' }).click()
  await page.getByPlaceholder('卷名').press('Enter')
  await expect(page.getByText('第1卷')).toBeVisible()

  // 新建章节（默认名「第1章」，创建后自动选中）
  await page.getByRole('button', { name: '新建章节' }).click()
  await page.getByPlaceholder('章节名').press('Enter')
  await expect(page.getByRole('button', { name: '第1章' })).toBeVisible()

  // 编辑器写入正文（触发防抖自动保存落库；落盘 debounce 为 3000ms，留足余量）
  const editor = page.locator('textarea').first()
  await editor.click()
  await editor.fill('这是E2E写入的正文内容，用于验证自动保存与持久化。')
  await page.waitForTimeout(4500)
})

test('刷新直达工作台路由：数据持久化且不再报「未找到该小说」（观察项回归）', async () => {
  await page.evaluate(() => window.location.reload())
  await page.waitForLoadState('domcontentloaded')

  // obs-route 修复：刷新直达 #/workbench/:novelId 应按 id 补种数据，而非误报未找到
  await expect(page.getByText('未找到该小说')).toHaveCount(0)
  await expect(page.getByText('章节目录', { exact: true })).toBeVisible()

  // 章节树仍展示已建章节；点击后正文从库里回填（限定章节树，避免驾驶舱快捷按钮同名）
  await page.locator('.group-ch').filter({ hasText: '第1章' }).click()
  await expect(page.locator('textarea').first()).toHaveValue(/这是E2E写入的正文内容/)
})
