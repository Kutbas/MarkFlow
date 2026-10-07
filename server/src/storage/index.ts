import { PgAdapter } from './pg-adapter.js'
import type { StorageAdapter } from './types.js'

let storagePromise: Promise<StorageAdapter> | null = null

/** 获取存储适配器（PostgreSQL 单后端；DATABASE_URL 必填） */
export function getStorage(): Promise<StorageAdapter> {
  storagePromise ??= build()
  return storagePromise
}

async function build(): Promise<StorageAdapter> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('请在环境变量中设置 DATABASE_URL（PostgreSQL 连接串）')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  const adapter = new PgAdapter(pool as never)
  await adapter.init()
  console.log('[MarkFlow] 存储后端: PostgreSQL')
  return adapter
}

/** 仅测试用：直接注入适配器实例（如 pglite 后端的 PgAdapter） */
export function setStorageOverride(adapter: StorageAdapter): void {
  storagePromise = Promise.resolve(adapter)
}

/** 仅测试用：重置单例 */
export function resetStorageForTest(): void {
  storagePromise = null
}
