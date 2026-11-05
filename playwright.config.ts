import { defineConfig } from 'playwright/test'

// E2E 冒烟测试（Electron 生产构建）：先 npm run build，再 npx playwright test
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
})
