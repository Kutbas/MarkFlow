import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { FsAdapter } from './fs-adapter.js'
import { PgAdapter } from './pg-adapter.js'
import type { StorageAdapter } from './types.js'

let storagePromise: Promise<StorageAdapter> | null = null

/** 根据 STORAGE 环境变量构建存储适配器（fs 默认 / postgres） */
export function getStorage(): Promise<StorageAdapter> {
  storagePromise ??= build()
  return storagePromise
}

async function build(): Promise<StorageAdapter> {
  if (config.storage === 'postgres') {
    if (!config.databaseUrl) throw new Error('STORAGE=postgres 需要设置 DATABASE_URL')
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5 })
    const adapter = new PgAdapter(pool as never)
    await adapter.init()
    console.log(`[MarkFlow] 存储后端: PostgreSQL`)
    return adapter
  }
  const stateDir = path.join(config.notesDir, '.markflow-state')
  fs.mkdirSync(stateDir, { recursive: true })
  console.log(`[MarkFlow] 存储后端: 文件系统（${config.notesDir}）`)
  return new FsAdapter(config.notesDir, stateDir)
}

/** 仅测试用：重置单例 */
export function resetStorageForTest(): void {
  storagePromise = null
}

/** 仅测试用：直接注入适配器实例（如 pglite 后端的 PgAdapter） */
export function setStorageOverride(adapter: StorageAdapter): void {
  storagePromise = Promise.resolve(adapter)
}
