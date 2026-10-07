/**
 * 全局测试环境：每个测试文件独立的 pglite（嵌入式 PostgreSQL）+ 播种 + 存储注入。
 * 必须最先于任何 src 模块求值（vitest setupFiles 语义）。
 */
process.env.AUTH_USERS = 'alice:alice123'
process.env.JWT_SECRET = 'test-secret'
process.env.MF_SEED_GRACE_MS ??= '150'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SEEDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../seeds/notes')
const tmpThemes = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-themes-'))
fs.writeFileSync(path.join(tmpThemes, 'demo.css'), 'body { color: red }')
process.env.THEMES_DIR = tmpThemes

const { PGlite } = await import('@electric-sql/pglite')
const { PgAdapter } = await import('../../src/storage/pg-adapter.js')
const { setStorageOverride } = await import('../../src/storage/index.js')

class PglitePoolShim {
  constructor(private readonly db: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[]; affectedRows?: number }> }) {}
  async query(sql: string, params?: unknown[]) {
    const res = await this.db.query(sql, params)
    return { rows: res.rows ?? [], rowCount: res.affectedRows }
  }
  async connect() {
    const self = this
    return {
      query: async (sql: string, params?: unknown[]) => self.query(sql, params),
      release: () => {},
    } as never
  }
}

const db = await PGlite.create()
const adapter = new PgAdapter(new PglitePoolShim(db as never) as never)
await adapter.init()

// 播种示例（与前端预期一致）
const walk = (dir: string, rel: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      void adapter.createFolder(relPath).catch(() => {})
      walk(path.join(dir, e.name), relPath)
    } else if (/\.md$/i.test(e.name)) {
      void adapter.createFile(relPath, fs.readFileSync(path.join(dir, e.name), 'utf8')).catch(() => {})
    }
  }
}
walk(SEEDS, '')
await new Promise((r) => setTimeout(r, 200)) // fire-and-forget 播种落定
setStorageOverride(adapter)

;(globalThis as Record<string, unknown>).__pgAdapter = adapter
;(globalThis as Record<string, unknown>).__pgDb = db
