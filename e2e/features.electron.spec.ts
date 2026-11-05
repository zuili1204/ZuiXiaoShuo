import { test, expect, _electron, type ElectronApplication, type Page } from 'playwright/test'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 发布候选验收：模板脚手架 / 章节快照 / AI 率检测 / DOCX 导出 / 拆书入口 / 文风库 / 章节评估 / 改稿级联 / 平台数据 / 隐私与帮助
// 不依赖真实 LLM 密钥；拆书仅验收入口与取消流程，文风仅验收导入与绑定入口。
const projectRoot = join(__dirname, '..')

// 章节树行定位：避免与驾驶舱「未来章节」快捷按钮同名导致 strict mode 冲突
function chapterRow(page: Page, title: string) {
  return page.locator('.group-ch').filter({ hasText: title })
}

test.describe.configure({ mode: 'serial' })

let electronApp: ElectronApplication
let page: Page
let appDataDir: string

test.beforeAll(async () => {
  appDataDir = mkdtempSync(join(tmpdir(), 'zxs-feat-'))
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
  rmSync(appDataDir, { recursive: true, force: true })
})

test('题材模板：新建时一键搭好首卷与黄金三章', async () => {
  await page.getByRole('button', { name: '新建小说' }).click()
  await expect(page.getByRole('heading', { name: '创建新小说' })).toBeVisible()
  await page.getByRole('button', { name: '都市重生', exact: true }).click()
  await page.getByPlaceholder('输入小说名称...').fill('模板验收之书')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  await page.getByRole('heading', { name: '模板验收之书' }).first().click()
  await page.waitForURL(/#\/workbench\//)
  await expect(page.getByText('章节目录', { exact: true })).toBeVisible()

  // 模板应用是建书后的异步补齐，等待脚手架落库
  await expect(page.getByText('第一卷 重回十六岁')).toBeVisible({ timeout: 30_000 })
  // 用章节树行定位，避免与驾驶舱「未来章节」快捷按钮同名
  await expect(chapterRow(page, '回到那一年')).toBeVisible()
  await expect(chapterRow(page, '第一桶金')).toBeVisible()
  await expect(chapterRow(page, '拦下那封信')).toBeVisible()
})

test('P0 面板：场景卡按细纲补齐，上下文预览展示预算区块', async () => {
  await chapterRow(page, '回到那一年').click()

  await page.getByTitle('场景卡', { exact: true }).click()
  await expect(page.getByText(/细纲覆盖 \d+\/\d+/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '关闭抽屉' }).click()

  await page.getByTitle('上下文预览', { exact: true }).click()
  await expect(page.getByText('作品事实（大纲 / 设定 / 角色）')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('本章场景卡')).toBeVisible()
  await expect(page.getByText(/token$/).first()).toBeVisible()
  await page.getByRole('button', { name: '关闭抽屉' }).click()
})

test('P1 面板：连贯性抽屉可对轨，追踪面板提供时间线与剧情线', async () => {
  await chapterRow(page, '回到那一年').click()

  await page.getByTitle('连贯性', { exact: true }).click()
  await expect(page.getByText('硬伤（需处理）')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('提示（可确认后忽略）')).toBeVisible()
  await page.getByRole('button', { name: '关闭抽屉' }).click()

  const trackingNav = page.getByRole('button', { name: '追踪', exact: true }).first()
  await trackingNav.click()
  await page.getByRole('button', { name: '时间线', exact: true }).click()
  await expect(page.getByText('还没有时间线事件。')).toBeVisible()
  await page.getByRole('button', { name: '剧情线', exact: true }).click()
  await expect(page.getByText('还没有剧情线。')).toBeVisible()
  await trackingNav.click()
})

test('章节快照：手动留档、预览旧版并恢复', async () => {
  await chapterRow(page, '回到那一年').click()
  const editor = page.locator('textarea').first()
  await editor.fill('第一版正文，用于验证快照留档。')
  await page.waitForTimeout(4500)

  await page.getByTitle('历史版本').click()
  await page.getByRole('button', { name: '手动快照' }).click()
  await expect(page.getByText('已保存当前版本')).toBeVisible()
  await expect(page.getByText('手动', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: '关闭抽屉' }).click()
  await editor.fill('第二版正文，用于验证恢复。')
  await page.waitForTimeout(4500)

  await page.getByTitle('历史版本').click()
  await page.getByRole('button', { name: '手动快照' }).click()
  await expect(page.getByText('手动', { exact: true })).toHaveCount(2)

  // 列表新的在前，最后一行是最早的「第一版」快照
  await page.getByRole('button', { name: '预览' }).last().click()
  await expect(page.getByText('第一版正文，用于验证快照留档。')).toBeVisible()
  await page.getByRole('button', { name: '返回列表' }).click()

  await page.getByRole('button', { name: '恢复' }).last().click()
  await page.getByRole('button', { name: '确认恢复？' }).click()
  await expect(page.getByText('已恢复该版本（恢复前的内容已另存快照）')).toBeVisible()

  await page.getByRole('button', { name: '关闭抽屉' }).click()
  await expect(editor).toHaveValue(/第一版正文/)
})

test('AI 率检测：手动出报告，切换章节后不串报告', async () => {
  const editor = page.locator('textarea').first()
  await editor.fill('在这个瞬间，仿佛时间都静止了。空气仿佛凝固，他的心中涌起一股暖流。这一切，都显得那么不真实。')

  // 打开抽屉即自动开跑（按钮入口只负责触发一次检测）
  await page.getByTitle('AI 率检测').click()
  await expect(page.getByText(/AI 味指数/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '关闭抽屉' }).click()

  await chapterRow(page, '第一桶金').click()
  await page.getByTitle('AI 率检测').click()
  // 抽屉自动为当前章重跑，报告抬头必须切到新章，旧章报告不得残留
  await expect(page.getByText('《第一桶金》')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('《回到那一年》')).toHaveCount(0)
  await page.getByRole('button', { name: '关闭抽屉' }).click()
})

test('DOCX 导出：经保存对话框落盘为有效 Word 包', async () => {
  const target = join(appDataDir, '验收导出.docx')
  await electronApp.evaluate(({ dialog }, filePath) => {
    const d = dialog as unknown as {
      showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }>
    }
    d.showSaveDialog = async () => ({ canceled: false, filePath })
  }, target)

  await page.getByTitle('导出格式').selectOption('docx')
  await page.getByTitle('导出小说').click()
  await page.getByRole('button', { name: /导出全部 \d+ 章/ }).click()

  await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true)
  const bytes = readFileSync(target)
  expect(bytes.length).toBeGreaterThan(1000)
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
})

test('数据目录迁移：设置页切换后复制稿件并立即生效', async () => {
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('navigation').getByRole('button', { name: '显示' }).click()
  await expect(page.getByText('内容目录', { exact: true })).toBeVisible()

  const target = join(appDataDir, '迁移后内容')
  await page.locator('input').first().fill(target)
  await page.getByRole('button', { name: '迁移并切换' }).click()

  await expect(page.getByText(/已迁移 \d+ 个文件并切换/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(target)).toBeVisible()
  expect(existsSync(target)).toBe(true)

  const paths = await page.evaluate(() => (window as any).electronAPI.data.getPaths())
  expect(paths.contentDir).toBe(target)
  expect(paths.databasePath).toContain('zuixiaoshuo.db')
})

test('文风库：粘贴语料可预览切章并入库，配方与工作台绑定入口可达', async () => {
  await page.evaluate(() => { window.location.hash = '#/' })
  await page.getByRole('button', { name: '文风库' }).click()
  await expect(page.getByText('学习表达方式，融合成作品专属文风')).toBeVisible()
  await expect(page.getByText('还没有语料。')).toBeVisible()

  await page.getByRole('button', { name: '导入语料' }).click()
  await expect(page.getByRole('heading', { name: '导入文风语料' })).toBeVisible()
  await page.getByRole('button', { name: /粘贴文本/ }).click()
  await page.getByPlaceholder('例如：某作者短篇集').fill('验收短篇')
  await page.getByPlaceholder('粘贴小说正文…').fill(
    `第一章 开端\n${'他推开门，雨声涌进来，街上没有人。'.repeat(30)}\n第二章 转折\n${'她抬头看了一眼，什么也没说，转身走了。'.repeat(30)}`,
  )
  await page.getByRole('button', { name: '预览切章' }).click()
  await expect(page.getByText('识别 2 章')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '导入', exact: true }).click()

  // 导入后自动选中新来源；尚未分析，只展示来源与概览
  await expect(page.getByText('验收短篇').first()).toBeVisible()
  await expect(page.getByText('还没有生成文风画像。')).toBeVisible()
  await expect(page.getByText('2 章')).toHaveCount(2)

  await page.getByRole('button', { name: '融合配方' }).click()
  await expect(page.getByText('把多本书的文风按权重合成一个目标')).toBeVisible()
  await expect(page.getByText('配方名称')).toBeVisible()

  // 工作台文风绑定抽屉：无配方时给出引导入口
  await page.evaluate(() => { window.location.hash = '#/' })
  await page.getByRole('heading', { name: '模板验收之书' }).first().click()
  await page.waitForURL(/#\/workbench\//)
  await page.getByTitle('绑定融合文风配方').click()
  await expect(page.getByText('文风绑定')).toBeVisible()
  await expect(page.getByText('还没有可用的融合配方。')).toBeVisible()
})

test('章节评估：三层检查与读者模拟可离线运行，模拟结果有标识', async () => {
  await chapterRow(page, '回到那一年').click()
  const editor = page.locator('textarea').first()
  await editor.fill(
    '林晚停在门外，手还搭在门把上。\n\n' +
    '“你终于来了。”门里传来一个她以为再也听不到的声音。\n\n' +
    '她猛地回头，走廊尽头却空无一人，只有一串湿脚印停在原地。\n\n' +
    '她攥紧袖中的玉佩，玉佩忽然烫了一下。',
  )
  await page.waitForTimeout(1000)

  await page.getByTitle('章节评估').click()
  await expect(page.getByRole('button', { name: '三层评估' })).toBeVisible()
  await page.getByRole('button', { name: '开始评估' }).click()
  await expect(page.getByText(/硬伤 \d+/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('可执行建议')).toBeVisible()

  await page.getByRole('button', { name: '读者模拟' }).click()
  await expect(page.getByText(/不是真实读者数据/)).toBeVisible()
  await page.getByRole('button', { name: '开始模拟' }).click()
  await expect(page.getByText('钩子强度')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/可执行建议（\d+）/)).toBeVisible()

  await page.getByRole('button', { name: '作者反馈' }).click()
  await page.getByPlaceholder('记一条修改意见，或说明接受/拒绝的原因…').fill('钩子可以再压后一点。')
  await page.getByRole('button', { name: '记一条批注' }).click()
  await expect(page.getByText('钩子可以再压后一点。')).toBeVisible()
  await page.getByRole('button', { name: '关闭抽屉' }).click()
})

test('改稿级联：版本 diff 可应用，影响分析列出后续章，任务可闭环', async () => {
  // 先给第二章写入含旧角色名的正文，作为影响分析的命中目标
  await chapterRow(page, '第一桶金').click()
  const chapterTwoEditor = page.locator('textarea').first()
  await chapterTwoEditor.fill('林晚推开门，屋里没有人。\n桌上留着一张纸条。')
  await page.waitForTimeout(4500)

  await chapterRow(page, '回到那一年').click()
  const editor = page.locator('textarea').first()
  await editor.fill('林晚站在门外。\n她听见屋里的钟声。')
  await page.waitForTimeout(4500)

  await page.getByTitle('历史版本').click()
  await page.getByRole('button', { name: '手动快照' }).click()
  await expect(page.getByText('已保存当前版本')).toBeVisible()
  await page.getByRole('button', { name: '关闭抽屉' }).click()

  await editor.fill('苏晚站在门外。\n她听见屋里的钟声。')
  await page.waitForTimeout(4500)

  await page.getByTitle('改稿').click()
  await expect(page.getByRole('button', { name: '版本对比' })).toBeVisible()
  await page.getByRole('button', { name: '开始对比' }).click()
  await expect(page.getByText(/新增 1 行/).first()).toBeVisible()
  await expect(page.getByText(/删除 1 行/).first()).toBeVisible()

  await page.getByRole('button', { name: '应用改动' }).click()
  await expect(page.getByText(/已应用改动/)).toBeVisible()

  // 自动识别可能没有角色库数据，手动补关键词后仍应命中第二章
  await page.getByRole('button', { name: '影响分析', exact: true }).click()
  const keyword = page.getByPlaceholder('补充关键词（角色名 / 地点 / 物品）')
  await keyword.fill('林晚')
  await keyword.press('Enter')
  await page.getByRole('button', { name: '分析影响' }).click()
  await expect(page.getByText(/扫描后续 \d+ 章，命中 \d+ 处/)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.w-\\[420px\\]').getByText('第一桶金', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '对命中章跑级联检查' }).click()
  await expect(page.getByText('级联检查结果')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '加入清单' }).first().click()
  await expect(page.getByText('已加入级联清单')).toBeVisible()

  await page.getByRole('button', { name: '修订任务', exact: true }).click()
  await expect(page.getByText(/确认「林晚」/)).toBeVisible()

  await page.getByRole('button', { name: '标记完成' }).click()
  await expect(page.getByText('当前筛选下没有任务。')).toBeVisible()
  await page.getByRole('button', { name: '已确认', exact: true }).click()
  await expect(page.getByText(/确认「林晚」/)).toBeVisible()

  // 跳转到目标章：抽屉关闭并切章
  await page.locator('.w-\\[420px\\]').getByRole('button', { name: '第一桶金', exact: true }).click()
  await expect(editor).toHaveValue(/林晚/)
})

test('平台数据：手工导入 7 天数据后显示趋势与异常章，评论情绪可读', async () => {
  await page.getByRole('button', { name: '数据', exact: true }).click()
  await expect(page.getByText('发布与数据', { exact: true })).toBeVisible()
  const sheet = page.locator('.w-\\[520px\\]')
  await expect(sheet.getByRole('button', { name: '趋势与异常' })).toBeVisible()

  await sheet.getByRole('button', { name: '去导入' }).click()
  const csvArea = sheet.locator('textarea')
  await csvArea.fill(
    '日期,阅读,读完率,评论,收益\n' +
    '2026-11-01,2000,70%,30,10\n' +
    '2026-11-02,1900,69%,28,9\n' +
    '2026-11-03,1800,68%,26,9\n' +
    '2026-11-04,1200,64%,20,7\n' +
    '2026-11-05,1100,63%,18,6\n' +
    '2026-11-06,1000,62%,16,6\n' +
    '2026-11-07,900,61%,14,5',
  )
  await sheet.getByRole('button', { name: '导入数据' }).click()
  await expect(sheet.getByText(/导入完成：新增 7 条/)).toBeVisible()

  await sheet.getByRole('button', { name: '趋势与异常' }).click()
  await expect(sheet.getByText('日均阅读')).toBeVisible()
  await expect(sheet.getByText('近 7 天阅读', { exact: true })).toBeVisible()
  await expect(sheet.getByText(/不代表因果/)).toBeVisible()

  // 章节数据：三章有读完率，其中「第一桶金」明显骤降
  await sheet.getByRole('button', { name: '数据导入' }).click()
  await sheet.getByRole('button', { name: '章节数据' }).click()
  await csvArea.fill(
    '章节,章节序号,阅读,读完率,评论,收益\n' +
    '回到那一年,1,18000,72%,120,52\n' +
    '第一桶金,2,16000,45%,90,44\n' +
    '拦下那封信,3,15000,70%,80,40\n' +
    '神秘章节,9,5000,65%,10,2',
  )
  await sheet.getByRole('button', { name: '导入数据' }).click()
  await expect(sheet.getByText(/导入完成：新增 4 条/)).toBeVisible()
  await expect(sheet.getByText('待对应章节（1）')).toBeVisible()

  // 没有映射时提示手工对应
  const bindSection = sheet.locator('section').filter({ hasText: '待对应章节' })
  await bindSection.locator('select').selectOption({ label: '第1章 回到那一年' })
  await bindSection.getByRole('button', { name: '对应' }).click()
  await expect(sheet.getByText(/已把「神秘章节」对应到本地章节/)).toBeVisible()

  // 评论：一条正面一条负向
  await sheet.getByRole('button', { name: '评论', exact: true }).click()
  await csvArea.fill(
    '日期,章节,内容\n' +
    '2026-11-01,回到那一年,太好看了，追了\n' +
    '2026-11-02,第一桶金,这章有点水，追不下去',
  )
  await sheet.getByRole('button', { name: '导入数据' }).click()
  await expect(sheet.getByText(/导入完成：新增 2 条/)).toBeVisible()

  await sheet.getByRole('button', { name: '趋势与异常' }).click()
  await expect(sheet.getByText('读完率骤降章')).toBeVisible()
  const anomalySection = sheet.locator('section').filter({ hasText: '读完率骤降章' })
  await expect(anomalySection.getByText('第一桶金')).toBeVisible()
  await expect(anomalySection.getByText(/可能原因|检查/).first()).toBeVisible()
  await expect(sheet.getByText('正面 1')).toBeVisible()
  await expect(sheet.getByText('负向 1')).toBeVisible()

  // 脱敏导出：不含章节名与精确数值
  const target = join(appDataDir, '平台数据脱敏.csv')
  await electronApp.evaluate(({ dialog }, filePath) => {
    const d = dialog as unknown as {
      showSaveDialog: () => Promise<{ canceled: boolean; filePath: string }>
    }
    d.showSaveDialog = async () => ({ canceled: false, filePath })
  }, target)
  await sheet.getByRole('button', { name: '数据导入' }).click()
  await sheet.getByRole('button', { name: '导出脱敏数据' }).click()
  await expect.poll(() => existsSync(target), { timeout: 30_000 }).toBe(true)
  const csv = readFileSync(target, 'utf8')
  expect(csv).toContain('读完率区间')
  expect(csv).not.toContain('神秘章节')
  expect(csv).not.toContain('18000')
})

test('存稿与系列：发布计划只生成排期，系列分组可保存', async () => {
  // 将模板章节标记为定稿，形成存稿
  await page.evaluate(async () => {
    await (window as any).electronAPI.db.query("UPDATE chapters SET status = 'final'")
  })
  // 关闭并重开面板，让存稿概览重新读取
  await page.getByRole('button', { name: '数据', exact: true }).click()
  await page.getByRole('button', { name: '数据', exact: true }).click()

  const sheet = page.locator('.w-\\[520px\\]')
  await sheet.getByRole('button', { name: '存稿与发布' }).click()
  await expect(sheet.getByText(/存稿（已定稿、未发布）/)).toBeVisible()
  await expect(sheet.getByText('第1章 回到那一年').first()).toBeVisible()
  await expect(sheet.getByText(/不会连接平台或自动发布/)).toBeVisible()

  await sheet.getByRole('button', { name: '一键排期' }).click()
  await expect(sheet.getByText(/已为 \d+ 章生成计划/)).toBeVisible()

  await sheet.getByRole('button', { name: '标记已发布' }).first().click()
  await expect(sheet.getByText(/已记录：发布到第 \d+ 章/)).toBeVisible()

  await sheet.getByRole('button', { name: '系列', exact: true }).click()
  await sheet.getByPlaceholder('系列名，留空表示单本').fill('验收系列')
  await sheet.getByRole('button', { name: '保存' }).click()
  await expect(sheet.getByText('验收系列', { exact: true }).first()).toBeVisible()
  await expect(sheet.getByText(/1 本 ·/).first()).toBeVisible()

  await page.getByRole('button', { name: '数据', exact: true }).click()
})

test('拆书入口可达，隐私与帮助页正常渲染', async () => {
  await page.evaluate(() => { window.location.hash = '#/' })
  await expect(page.getByRole('button', { name: '拆书分析' })).toBeVisible()

  await page.getByRole('button', { name: '拆书分析' }).click()
  await expect(page.getByRole('heading', { name: '拆书分析' })).toBeVisible()
  await expect(page.getByText('选择 .txt 或 .md 全本文件。')).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByRole('heading', { name: '拆书分析' })).toHaveCount(0)

  await page.getByRole('button', { name: '设置' }).first().click()
  await page.getByRole('button', { name: '隐私与权限' }).click()
  await expect(page.getByRole('heading', { name: '隐私与权限' })).toBeVisible()
  await expect(page.getByText('免责声明')).toBeVisible()

  await page.getByRole('button', { name: '帮助' }).click()
  await expect(page.getByRole('heading', { name: '快速上手' })).toBeVisible()
  await page.getByRole('button', { name: /功能说明/ }).click()
  await expect(page.getByRole('heading', { name: '功能说明' })).toBeVisible()
})
