/** 收尾分支覆盖：config 各默认分支、onConnect 鉴权形态、WS 非法路径、exportPageOrigin */
import http from 'node:http'
import path from 'node:path'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { collabHooks, hocuspocus } from '../src/collab/hocuspocus.js'

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

afterEach(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
  vi.restoreAllMocks()
})

afterAll(() => {
  vi.resetModules()
})

describe('config 剩余分支', () => {
  it('NODE_ENV=production / PORT 空串 / AUTH_USERS 带空段', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PORT', '')
    vi.stubEnv('MF_ENV_FILE', '/nonexistent/.env')
    vi.stubEnv('AUTH_USERS', 'u1:p1, ,u2:p2')
    const { config } = await import('../src/config.js')
    expect(config.isDev).toBe(false)
    expect(config.port).toBe(8080)
    expect(config.users).toHaveLength(2)
  })
})

describe('onConnect 鉴权形态', () => {
  it('无 cookie 但有 Bearer / 空 headers 拒绝 / 非 Bearer 回落', async () => {
    const svc = await import('../src/auth/service.js')
    const hp = await import('../src/collab/hocuspocus.js')
    const token = await svc.issueToken('alice')
    await expect(
      hp.collabHooks.onConnect!({ requestHeaders: new Headers({ authorization: `Bearer ${token}` }) } as never),
    ).resolves.toBeUndefined()
    await expect(
      hp.collabHooks.onConnect!({ requestHeaders: new Headers() } as never),
    ).rejects.toThrow('未登录')
    expect(
      await svc.identityFromHeaders({ authorization: 'Basic xyz', cookie: `mf_token=${token}` }),
    ).toBe('alice')
  })
})

describe('WS 非法升级路径', () => {
  it('非 /collab 路径被销毁', async () => {
    const { attachCollab } = await import('../src/collab/ws.js')
    attachCollab(server, hocuspocus)
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/wrong`)
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true))
      ws.on('close', () => resolve(true))
      setTimeout(() => resolve(false), 4000)
    })
    expect(closed).toBe(true)
  })
})

describe('exportPageOrigin 分支', () => {
  it('未设置 → 本服务端口；设置带尾斜杠 → 去斜杠', async () => {
    const { exportPageOrigin } = await import('../src/export/pdf.js')
    const before = process.env.EXPORT_ORIGIN
    delete process.env.EXPORT_ORIGIN
    expect(exportPageOrigin()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    process.env.EXPORT_ORIGIN = 'http://localhost:5173/'
    expect(exportPageOrigin()).toBe('http://localhost:5173')
    if (before) process.env.EXPORT_ORIGIN = before
    else delete process.env.EXPORT_ORIGIN
  })
})

describe('config 全默认分支', () => {
  it('未设置 NOTES_DIR/THEMES_DIR/WEB_DIST/JWT_SECRET/AUTH_USERS 时取默认值', async () => {
    vi.resetModules()
    vi.stubEnv('MF_ENV_FILE', '/nonexistent/.env')
    for (const k of ['NOTES_DIR', 'THEMES_DIR', 'WEB_DIST', 'JWT_SECRET', 'AUTH_USERS', 'HOST']) {
      delete process.env[k]
    }
    const { config } = await import('../src/config.js')
    expect(config.host).toBe('::')
    expect(config.jwtSecret).toBe('dev-insecure-secret')
    expect(config.users).toEqual([{ name: 'admin', secret: 'admin123' }])
    expect(config.notesDir).toContain('data/notes')
    expect(config.themesDir).toContain('data/themes')
    expect(config.webDist).toContain('web/dist')
  })
})

describe('files 路由 catch 路径', () => {
  it('rename/move/remove 均可到达 catch 分支（404 场景）', async () => {
    const res1 = await fetch(`${base}/api/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: '不存在甲.md', newName: 'y.md' }),
    })
    expect(res1.status).toBe(404)
    const res2 = await fetch(`${base}/api/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: '不存在乙.md', newParentDir: '' }),
    })
    expect(res2.status).toBe(404)
    const res3 = await fetch(`${base}/api/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: '不存在丙.md' }),
    })
    expect(res3.status).toBe(404)
  })
})
