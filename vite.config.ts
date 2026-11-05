import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
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
