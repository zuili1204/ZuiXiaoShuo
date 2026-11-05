import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import { existsSync, readFileSync } from 'fs'

// 密钥从 ZXS_SKILL_KEY 或 .env.skills.local 读取（与 scripts/pack-skills.mjs 规则一致）
function loadSkillKey(): string {
  const fromEnv = process.env.ZXS_SKILL_KEY?.trim()
  if (fromEnv) return fromEnv
  const keyFile = path.resolve(__dirname, '.env.skills.local')
  if (existsSync(keyFile)) {
    const line = readFileSync(keyFile, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.startsWith('ZXS_SKILL_KEY='))
    const value = line?.slice('ZXS_SKILL_KEY='.length).trim()
    if (value) return value
  }
  throw new Error('缺少技能加密密钥：请设置 ZXS_SKILL_KEY，或创建 .env.skills.local')
}

const SKILL_KEY = loadSkillKey()

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          define: {
            __ZXS_SKILL_KEY__: JSON.stringify(SKILL_KEY)
          },
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['better-sqlite3']
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared')
    }
  },
  server: {
    host: '0.0.0.0',
    // 固定独立端口 + strictPort：避免与机器上其他 vite 项目（如 WorkEasyERP 的 ::1:5173）
    // 发生双栈端口撞车，导致 electron 通过 localhost 解析优先命中 IPv6 而加载到别的项目页面
    port: 5188,
    strictPort: true,
    allowedHosts: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
