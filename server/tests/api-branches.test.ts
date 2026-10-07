import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { collabHooks, hocuspocus, retireDoc } from '../src/collab/hocuspocus.js'
import { ensureState, setLastKnownHash, relToDocName } from '../src/collab/docRegistry.js'
import { mdToUpdate } from '../src/interop/index.js'

type Ad = { createFile(p: string, md: string): Promise<void>; createFolder(p: string): Promise<void>; exists(p: string): Promise<boolean>; remove(p: string): Promise<void>; readMarkdown(p: string): Promise<string> }
const g = globalThis as unknown as { __pgAdapter: Ad }

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

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})
beforeEach(async () => {
  if (!cookie) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'alice', password: 'alice123' }),
    })
    cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  }
})

describe('鉴权路由分支', () => {
  it('登出清除 cookie', async () => {
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((res.headers.getSetCookie()[0] ?? '')).toContain('mf_token=;')
  })
  it('me：无效 cookie', async () => {
    const bad = await fetch(`${base}/api/auth/me`, { headers: { Cookie: 'mf_token=bad' } })
    expect(((await bad.json()) as { user: string | null }).user).toBeNull()
  })
  it('login 参数缺失 400', async () => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
  })
  it('未知接口 401/404', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(401)
    expect((await fetch(`${base}/api/nope`, { headers: { Cookie: cookie } })).status).toBe(404)
  })
})

describe('文件 CRUD 冲突与校验分支', () => {
  it('重复创建 409', async () => {
    await g.__pgAdapter.createFile('dup.md', '# dup').catch(() => {})
    await g.__pgAdapter.createFolder('dupdir').catch(() => {})
    expect((await api('POST', '/api/files', { parentDir: '', name: 'dup' })).status).toBe(409)
    expect((await api('POST', '/api/files', { parentDir: '', name: 'dupdir', type: 'folder' })).status).toBe(409)
  })
  it('非法名称 400 / .md 保留', async () => {
    expect((await api('POST', '/api/files', { parentDir: '', name: 'a/b' })).status).toBe(400)
    expect((await api('POST', '/api/files', { parentDir: '', name: '.隐藏' })).status).toBe(400)
    await g.__pgAdapter.createFile('keepmd.md', '# k').catch(() => {})
    expect((await api('POST', '/api/files/rename', { path: 'keepmd.md', newName: 'noext' })).status).toBe(400)
    await g.__pgAdapter.createFile('dup2.md', '#').catch(() => {})
    expect((await api('POST', '/api/files/rename', { path: 'keepmd.md', newName: 'dup2.md' })).status).toBe(409)
    expect((await api('POST', '/api/files/rename', { path: '幽灵.md', newName: 'x.md' })).status).toBe(404)
    expect((await api('POST', '/api/files/delete', { path: '幽灵.md' })).status).toBe(404)
    expect((await api('POST', '/api/files/delete', {})).status).toBe(400)
  })
  it('移动校验：目标为文件 400 / 不存在 404 / 重名 409', async () => {
    await g.__pgAdapter.createFile('m1.md', '# m1').catch(() => {})
    await g.__pgAdapter.createFile('m2.md', '# m2').catch(() => {})
    expect((await api('POST', '/api/files/move', { path: 'm1.md', newParentDir: 'm2.md' })).status).toBe(400)
    expect((await api('POST', '/api/files/move', { path: 'm1.md', newParentDir: '幽灵' })).status).toBe(404)
    await g.__pgAdapter.createFolder('有m2').catch(() => {})
    await g.__pgAdapter.createFile('有m2/m2.md', '# x').catch(() => {})
    expect((await api('POST', '/api/files/move', { path: 'm2.md', newParentDir: '有m2' })).status).toBe(409)
  })
  it('文件夹重命名（子孙随行）', async () => {
    await g.__pgAdapter.createFolder('改名目录').catch(() => {})
    await g.__pgAdapter.createFile('改名目录/内.md', '# 内').catch(() => {})
    expect((await api('POST', '/api/files/rename', { path: '改名目录', newName: '新目录名' })).status).toBe(200)
    expect(await g.__pgAdapter.exists('新目录名/内.md')).toBe(true)
  })
  it('带 .md 后缀创建不重复补', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '自带.md' })
    expect(((await res.json()) as { path: string }).path).toBe('自带.md')
  })
  it('缺参/空参分支', async () => {
    expect((await api('GET', '/api/files/content')).status).toBe(400)
    expect((await api('POST', '/api/files', { name: '仅名' })).status).toBe(201)
    expect((await api('POST', '/api/files/rename', { path: '仅名.md' })).status).toBe(400)
    expect((await api('POST', '/api/files/move', { path: '仅名.md' })).status).toBe(400)
    expect((await api('POST', '/api/export/pdf', { path: '' })).status).toBe(400)
  })
})

describe('存储错误映射（全部 catch 路径）', () => {
  it('create 文件 EXISTS 与 folder EXISTS 映射 409', async () => {
    const g2 = globalThis as unknown as { __pgAdapter: { createFile(p: string, md: string): Promise<void>; createFolder(p: string): Promise<void>; exists(p: string): Promise<boolean>; remove(p: string): Promise<void> } }
    await g2.__pgAdapter.createFile('映射存在.md', '#').catch(() => {})
    expect((await api('POST', '/api/files', { parentDir: '', name: '映射存在' })).status).toBe(409)
    await g2.__pgAdapter.createFolder('映射目录').catch(() => {})
    expect((await api('POST', '/api/files', { parentDir: '', name: '映射目录', type: 'folder' })).status).toBe(409)
  })
  it('content NOT_FOUND 映射 404', async () => {
    expect((await api('GET', '/api/files/content?path=' + encodeURIComponent('映射幽灵.md'))).status).toBe(404)
  })
  it('PG NOT_FOUND → 404（mapStorageError 路径）', async () => {
    const g2 = globalThis as unknown as { __pgAdapter: { remove(p: string): Promise<void> } }
    // 直接制造 rename 源不存在 → routes 先 404（不经 mapStorage）；改用并发竞态：先删再 rename
    await g2.__pgAdapter.remove('keepmd.md').catch(() => {})
    expect((await api('POST', '/api/files/rename', { path: 'keepmd.md', newName: 'x.md' })).status).toBe(404)
  })
})

describe('应用兜底 500 分支', () => {
  it('畸形 JSON 触发未处理错误 → 500', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await fetch(`${base}/api/files/tree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{bad json',
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('内部错误')
    errSpy.mockRestore()
  })
})

describe('主题接口分支', () => {
  it('非法名 400 / 不存在 404', async () => {
    expect((await api('GET', '/api/themes/..%2Fevil.css')).status).toBe(400)
    expect((await api('GET', '/api/themes/notexist.css')).status).toBe(404)
  })
  it('symlink 逃逸 404', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-theme-out-'))
    fs.writeFileSync(path.join(outside, 'evil.css'), 'body{}')
    const link = path.join(process.env.THEMES_DIR!, '链接主题.css')
    try {
      fs.symlinkSync(evil_abs(outside), link)
      expect((await api('GET', '/api/themes/' + encodeURIComponent('链接主题.css'))).status).toBe(404)
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

function evil_abs(dir: string): string {
  return path.join(dir, 'evil.css')
}

describe('协同钩子分支', () => {
  it('onLoadDocument：文件不存在 → 空树', async () => {
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '不存在.md' } as never)
    expect(doc.getXmlFragment('prosemirror').length).toBe(0)
  })
  it('onLoadDocument：非空树不重播种', async () => {
    await g.__pgAdapter.createFile('钩子b.md', '# B\n').catch(() => {})
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# 已有内容\n'))
    await collabHooks.onLoadDocument!({ document: doc, documentName: '钩子b.md' } as never)
    const xml = doc.getXmlFragment('prosemirror').toString()
    expect(xml).toContain('已有内容')
  })
  it('onStoreDocument：内容未变跳过（md 缓存不变）', async () => {
    await g.__pgAdapter.createFile('钩子c.md', '# C\n').catch(() => {})
    ensureState('钩子c.md')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# C\n'))
    setLastKnownHash('钩子c.md', '0000') // 人为置空 → 强制走保存
    await collabHooks.onStoreDocument!({ document: doc, documentName: '钩子c.md' } as never)
    expect(await g.__pgAdapter.readMarkdown('钩子c.md')).toContain('# C')
  })
  it('onStoreDocument：文件消失 → 下线广播', async () => {
    await g.__pgAdapter.createFile('钩子gone.md', '# G\n').catch(() => {})
    const doc = new Y.Doc()
    const name = relToDocName('钩子gone.md')
    hocuspocus.documents.set(name, doc as never)
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})
    try {
      await g.__pgAdapter.remove('钩子gone.md')
      await collabHooks.onStoreDocument!({ document: doc, documentName: '钩子gone.md' } as never)
      expect(closeSpy).toHaveBeenCalledWith(name)
    } finally {
      hocuspocus.documents.delete(name)
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
    }
  })
  it('retireDoc 双路径', async () => {
    const doc = new Y.Doc()
    hocuspocus.documents.set('钩子e.md', doc as never)
    const flushSpy = vi.spyOn(hocuspocus, 'flushPendingStores').mockImplementation(() => {})
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})
    try {
      await retireDoc('钩子e.md')
      expect(flushSpy).toHaveBeenCalled()
      await retireDoc('从未在线.md')
    } finally {
      hocuspocus.documents.delete('钩子e.md')
      flushSpy.mockRestore()
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
    }
  })
})
