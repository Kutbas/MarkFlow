import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['tests/helpers/pg-global.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html-spa'],
      include: ['src/**', '../shared/src/**'],
      // 相对 server 根目录的 glob（v8 provider 要求）
      exclude: ['**/index.ts', '**/scripts/**', '**/*.d.ts', '**/storage/types.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
})
