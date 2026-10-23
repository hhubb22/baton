import stylex from '@stylexjs/unplugin/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

const stylexPlugin: Plugin = stylex({
  unstable_moduleResolution: { type: 'commonJS', rootDir: root },
  // 类名带上源文件和样式键，方便在浏览器里定位。
  debug: process.env.NODE_ENV !== 'production',
})

// Vitest 的服务器没有 HTTP 端口，StyleX 开发服务器里的轮询定时器不会被清理，测试进程无法退出。
// 测试只需要编译样式，不需要热更新。
if (process.env.VITEST) delete stylexPlugin.configureServer

const backend = process.env.BATON_DEV_BACKEND

export default defineConfig({
  plugins: [stylexPlugin, react()],
  server: {
    host: 'localhost',
    port: 5173,
    proxy: backend
      ? {
          '/api': {
            target: backend,
            changeOrigin: true,
            ws: true,
            configure(proxy) {
              proxy.on('proxyReq', (request) => request.setHeader('Origin', new URL(backend).origin))
              proxy.on('proxyReqWs', (request) => request.setHeader('Origin', new URL(backend).origin))
            },
          },
        }
      : undefined,
    // 图标直接读 design/resources/assets。
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
