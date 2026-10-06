import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 协同端到端测试有真实 WebSocket 与防抖等待，串行更稳
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html-spa'],
      include: ['src/**', '../shared/src/**'],
      exclude: ['src/index.ts', 'src/scripts/**', 'src/**/*.d.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
