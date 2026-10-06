/**
 * 收尾分支覆盖：config 各默认分支、onConnect 鉴权形态、WS 非法路径、
 * externalSync 异常兜底、watcher 临时文件忽略、子目录创建/移动、500 兜底等。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { collabHooks, hocuspocus } from '../src/collab/hocuspocus.js'
import { startExternalSync, dispatchNoteEvent } from '../src/collab/externalSync.js'
import { startNoteWatcher } from '../src/files/watcher.js'
import { ensureState, relToDocName } from '../src/collab/docRegistry.js'

const NOTES = process.env.NOTES_DIR!

let server: http.Server
let base: string
let cookie = ''

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

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
    vi.stubEnv('AUTH_USERS', 'u1:p1, ,u2:p2')
    const { config } = await import('../src/config.js')
    expect(config.isDev).toBe(false)
    expect(config.port).toBe(8080)
    expect(config.users).toHaveLength(2)
  })

  it('全部环境变量缺省时的默认值', async () => {
    vi.resetModules()
    vi.stubEnv('MF_ENV_FILE', '/nonexistent/.env')
    for (const k of ['PORT', 'HOST', 'NOTES_DIR', 'THEMES_DIR', 'WEB_DIST', 'JWT_SECRET', 'AUTH_USERS']) {
      delete process.env[k]
    }
    const { config } = await import('../src/config.js')
    expect(config.port).toBe(8080)
    expect(config.host).toBe('::')
    expect(config.jwtSecret).toBe('dev-insecure-secret')
    expect(config.users).toEqual([{ name: 'admin', secret: 'admin123' }])
    expect(config.notesDir).toContain('data/notes')
    expect(config.themesDir).toContain('data/themes')
    expect(config.webDist).toContain('web/dist')
  })

  it('MF_ENV_FILE 指向不存在文件 → 静默（loadEnvFile catch 分支）', async () => {
    vi.resetModules()
    vi.stubEnv('MF_ENV_FILE', '/nonexistent/.env')
    vi.stubEnv('NOTES_DIR', path.join(NOTES, 'cfg-test'))
    const { config } = await import('../src/config.js')
    expect(config.notesDir).toContain('cfg-test')
  })
})

describe('onConnect 鉴权形态分支', () => {
  it('无 cookie 但有 Bearer 头 / 非 Bearer 回落 / 空 headers 拒绝', async () => {
    // 前面的 resetModules 已分裂注册表：统一从同一注册表取签发与校验
    const svc = await import('../src/auth/service.js')
    const hp = await import('../src/collab/hocuspocus.js')
    const token = await svc.issueToken('alice')
    await expect(
      hp.collabHooks.onConnect!({
        requestHeaders: new Headers({ authorization: `Bearer ${token}` }),
      } as never),
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
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/wrong`)
    const closed = await new Promise<boolean>((resolve) => {
      ws.on('error', () => resolve(true))
      ws.on('close', () => resolve(true))
      setTimeout(() => resolve(false), 4000)
    })
    expect(closed).toBe(true)
  })
})

describe('externalSync 异常兜底（handleNoteEvent 抛错不致崩溃）', () => {
  it('不可读文件触发 catch 分支', async () => {
    const file = '不可读.md'
    const abs = path.join(NOTES, file)
    fs.writeFileSync(abs, '# x\n')
    fs.chmodSync(abs, 0o000)
    ensureState(file)
    hocuspocus.documents.set(relToDocName(file), new Y.Doc() as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // 直接分发事件（该分支与 watcher 时序解耦）
    await dispatchNoteEvent({ relPath: file, kind: 'change' })
    expect(errSpy).toHaveBeenCalled()
    hocuspocus.documents.delete(relToDocName(file))
    fs.chmodSync(abs, 0o644)
    fs.rmSync(abs)
    errSpy.mockRestore()
  }, 10000)
})

describe('watcher 临时落盘文件忽略', () => {
  it('.tmp-markflow- 前缀不产生 NoteEvent', async () => {
    const { onNoteEvent } = await import('../src/files/watcher.js')
    const seen: string[] = []
    const off = onNoteEvent((e) => seen.push(e.relPath))
    const watcher = startNoteWatcher()
    fs.writeFileSync(path.join(NOTES, '.tmp-markflow-abc'), 'partial')
    await new Promise((r) => setTimeout(r, 1000))
    off()
    await watcher.close()
    expect(seen.some((p) => p.includes('tmp-markflow'))).toBe(false)
  }, 10000)
})

describe('子目录创建与移动的返回路径分支', () => {
  it('在子目录中创建文件/文件夹并移动回根目录', async () => {
    fs.mkdirSync(path.join(NOTES, '子目录'), { recursive: true })
    const f = await api('POST', '/api/files', { parentDir: '子目录', name: '嵌套新' })
    expect(((await f.json()) as { path: string }).path).toBe('子目录/嵌套新.md')

    const d = await api('POST', '/api/files', { parentDir: '子目录', name: '新文件夹', type: 'folder' })
    expect(((await d.json()) as { path: string }).path).toBe('子目录/新文件夹')

    const m = await api('POST', '/api/files/move', { path: '子目录/嵌套新.md', newParentDir: '' })
    expect(((await m.json()) as { path: string }).path).toBe('嵌套新.md')
    expect(fs.existsSync(path.join(NOTES, '嵌套新.md'))).toBe(true)
  })

  it('移动文件夹自身内部（dir 移入其子目录）被拒', async () => {
    fs.mkdirSync(path.join(NOTES, '父目录/子目录'), { recursive: true })
    const res = await api('POST', '/api/files/move', {
      path: '父目录',
      newParentDir: '父目录/子目录',
    })
    expect(res.status).toBe(400)
  })
})

describe('应用兜底 500 分支', () => {
  it('不可读文件触发未处理错误 → 500', async () => {
    if (process.platform === 'win32') return // chmod 语义不同
    const abs = path.join(NOTES, '无权限.md')
    fs.writeFileSync(abs, '# x')
    fs.chmodSync(abs, 0o000)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await api('GET', `/api/files/content?path=${encodeURIComponent('无权限.md')}`)
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('内部错误')
    fs.chmodSync(abs, 0o644)
    fs.rmSync(abs)
    errSpy.mockRestore()
  })
})

describe('externalSync 其余分支', () => {
  it('change 事件但文件已消失 → 静默返回', async () => {
    ensureState('消失.md')
    hocuspocus.documents.set(relToDocName('消失.md'), new Y.Doc() as never)
    await expect(
      dispatchNoteEvent({ relPath: '消失.md', kind: 'change' }),
    ).resolves.toBeUndefined()
    hocuspocus.documents.delete(relToDocName('消失.md'))
  })

  it('无关文件的 unlink 不影响其他在线文档（continue 分支）', async () => {
    const keep = '保留.md'
    ensureState(keep)
    const doc = new Y.Doc()
    hocuspocus.documents.set(relToDocName(keep), doc as never)
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})
    try {
      dispatchNoteEvent({ relPath: '无关目录', kind: 'unlink' })
      await new Promise((r) => setTimeout(r, 100))
      expect(closeSpy).not.toHaveBeenCalled()
      // 前缀不匹配：'保留x.md' 不受 '保留' 影响？——'保留.md'.startsWith('保留/') false → continue ✓
      dispatchNoteEvent({ relPath: keep.slice(0, 2), kind: 'unlink' })
      await new Promise((r) => setTimeout(r, 100))
      expect(hocuspocus.documents.get(relToDocName(keep))).toBe(doc)
    } finally {
      hocuspocus.documents.delete(relToDocName(keep))
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
    }
  })
})

describe('watcher 非 md 文件 change → 仅广播 tree', () => {
  it('txt 变更不产生 NoteEvent', async () => {
    const { onNoteEvent } = await import('../src/files/watcher.js')
    const seen: string[] = []
    const off = onNoteEvent((e) => seen.push(e.relPath))
    const watcher = startNoteWatcher()
    await new Promise((r) => setTimeout(r, 300))
    const txt = path.join(NOTES, '普通.txt')
    fs.writeFileSync(txt, 'x')
    await new Promise((r) => setTimeout(r, 1200))
    off()
    await watcher.close()
    fs.rmSync(txt)
    expect(seen).toEqual([])
  }, 10000)
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
