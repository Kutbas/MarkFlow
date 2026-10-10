/** bootstrap PG 播种 + SSE 订阅广播（全局 pglite 注入） */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { sseHub } from '../src/events.js'

const g = globalThis as unknown as { __pgAdapter: { readTree(): Promise<{ path: string }[]>; createFile(p: string, md: string): Promise<void> } }

let server: http.Server
let base: string
let cookie = ''

beforeEach(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  if (!cookie) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice', password: 'alice123' }),
    })
    cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  }
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('bootstrap PG 播种', () => {
  it('空库播种 + 非空跳过 + seeds 缺失静默', async () => {
    const SEEDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seeds')
    process.env.SEEDS_DIR = SEEDS
    // 直接构造空 adapter 场景：用独立 pglite
    const { PGlite } = await import('@electric-sql/pglite')
    const { PgAdapter } = await import('../src/storage/pg-adapter.js')
    const { setStorageOverride } = await import('../src/storage/index.js')
    class Shim {
      constructor(private db: { query(s: string, p?: unknown[]): Promise<{ rows: any[]; affectedRows?: number }> }) {}
      async query(s: string, p?: unknown[]) { const r = await this.db.query(s, p); return { rows: r.rows ?? [], rowCount: r.affectedRows } }
      async connect() { const self = this; return { query: async (s: string, p?: unknown[]) => self.query(s, p), release: () => {} } as never }
    }
    const db = await PGlite.create()
    const adapter = new PgAdapter(new Shim(db as never) as never)
    await adapter.init()
    setStorageOverride(adapter)
    const { seedIfEmpty } = await import('../src/bootstrap.js')

    await seedIfEmpty()
    // readTree 是嵌套树（children 在目录节点下），递归收集所有层级的 path 再断言
    type TreeNode = { path: string; children?: TreeNode[] }
    const allPaths = (nodes: TreeNode[]): string[] =>
      nodes.flatMap((n) => [n.path, ...(n.children ? allPaths(n.children) : [])])
    expect(allPaths(await adapter.readTree())).toContain('开始/欢迎使用 MarkFlow.md')
    await seedIfEmpty() // 幂等
    expect(allPaths(await adapter.readTree()).filter((p2) => p2 === '开始/欢迎使用 MarkFlow.md')).toHaveLength(1)

    process.env.SEEDS_DIR = '/nonexistent-seeds'
    await expect(seedIfEmpty()).resolves.toBeUndefined()
    await db.close().catch(() => {})
    // 还原全局注入（后续测试用主 adapter）
    setStorageOverride(g.__pgAdapter as never)
  }, 20_000)
})

describe('SSE 事件流', () => {
  it('订阅后收到广播事件', async () => {
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie, Accept: 'text/event-stream' } })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value!)).toContain('connected')
    sseHub.broadcast('tree', { reason: 'add', path: 'x.md' })
    const deadline = Date.now() + 5000
    let got = ''
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('读超时')), 4000))])
      got += new TextDecoder().decode(chunk.value ?? new Uint8Array())
      if (got.includes('event: tree')) break
    }
    expect(got).toContain('"path":"x.md"')
    await reader.cancel()
  })

  it('未登录禁止订阅 SSE', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401)
  })

  it('res.write 抛错时移除客户端不致崩溃', async () => {
    let writes = 0
    const bad = { writeHead: () => {}, on: () => {}, write: (_d: unknown) => { writes++; if (writes > 1) throw new Error('broken') } } as unknown as import('express').Response
    sseHub.subscribe(bad)
    expect(() => sseHub.broadcast('tree', { x: 1 })).not.toThrow()
  })
})

describe('主题列表映射回调', () => {
  it('返回结构化主题列表', async () => {
    const res = await fetch(`${base}/api/themes`, { headers: { Cookie: cookie } })
    const { themes } = (await res.json()) as { themes: { name: string; url: string }[] }
    expect(themes.length).toBeGreaterThan(0)
    expect(themes[0]!.url).toMatch(/^\/api\/themes\//)
  })
})
