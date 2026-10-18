import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const apiTarget = process.env.BATON_DEV_API ?? 'https://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), ...(process.env.VITEST ? [] : [basicSsl()])],
  server: {
    host: 'localhost',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
        ws: true,
        secure: false,
      },
    },
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
