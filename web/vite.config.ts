import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发模式：API 与协同 WebSocket 均代理到本地 8080 后端
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
      '/collab': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        export: resolve(__dirname, 'export.html'),
      },
    },
  },
})
