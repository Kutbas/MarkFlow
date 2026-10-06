/**
 * API 分支全覆盖：文件 CRUD 冲突/校验、主题 400/404、鉴权路由、404、静态托管、
 * 协同钩子（onLoadDocument/onStoreDocument）分支。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { collabHooks, hocuspocus, retireDoc } from '../src/collab/hocuspocus.js'
import { ensureState, recordDiskBaseline, setLastKnownHash, relToDocName } from '../src/collab/docRegistry.js'
import { mdToUpdate } from '../src/interop/index.js'

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

  it('me：有效 / 无效 cookie', async () => {
    expect(((await (await api('GET', '/api/auth/me')).json()) as { user: string | null }).user).toBe('alice')
    const bad = await fetch(`${base}/api/auth/me`, { headers: { Cookie: 'mf_token=bad' } })
    expect(((await bad.json()) as { user: string | null }).user).toBeNull()
  })

  it('login 参数缺失 400', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('未知接口 404', async () => {
    const anon = await fetch(`${base}/api/nope`)
    expect(anon.status).toBe(401) // 未带 cookie 先被鉴权拦截
    const res = await fetch(`${base}/api/nope`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(404)
  })
})

describe('文件 CRUD 冲突与校验分支', () => {
  it('重复创建 409（文件与文件夹）', async () => {
    fs.writeFileSync(path.join(NOTES, 'dup.md'), '# dup')
    fs.mkdirSync(path.join(NOTES, 'dupdir'))
    expect((await api('POST', '/api/files', { parentDir: '', name: 'dup' })).status).toBe(409)
    expect((await api('POST', '/api/files', { parentDir: '', name: 'dupdir', type: 'folder' })).status).toBe(409)
  })

  it('非法名称 400 / 文件保留 .md 校验', async () => {
    expect((await api('POST', '/api/files', { parentDir: '', name: 'a/b' })).status).toBe(400)
    expect((await api('POST', '/api/files', { parentDir: '', name: '.隐藏' })).status).toBe(400)
    // 重命名文件去掉 .md 后缀 → 400
    fs.writeFileSync(path.join(NOTES, 'keepmd.md'), '# k')
    expect((await api('POST', '/api/files/rename', { path: 'keepmd.md', newName: 'noext' })).status).toBe(400)
    // 重命名到已存在名称 → 409
    expect((await api('POST', '/api/files/rename', { path: 'keepmd.md', newName: 'dup.md' })).status).toBe(409)
    // 不存在路径 → 404
    expect((await api('POST', '/api/files/rename', { path: '幽灵.md', newName: 'x.md' })).status).toBe(404)
    expect((await api('POST', '/api/files/delete', { path: '幽灵.md' })).status).toBe(404)
    // 参数缺失 → 400
    expect((await api('POST', '/api/files/delete', {})).status).toBe(400)
  })

  it('移动目标是文件时 400 / 目标重名 409 / 不存在 404', async () => {
    fs.writeFileSync(path.join(NOTES, 'm1.md'), '# m1')
    fs.writeFileSync(path.join(NOTES, 'm2.md'), '# m2')
    expect((await api('POST', '/api/files/move', { path: 'm1.md', newParentDir: 'm2.md' })).status).toBe(400)
    expect((await api('POST', '/api/files/move', { path: 'm1.md', newParentDir: '幽灵' })).status).toBe(404)
    fs.mkdirSync(path.join(NOTES, '有m2'), { recursive: true })
    fs.writeFileSync(path.join(NOTES, '有m2', 'm2.md'), '# x')
    expect((await api('POST', '/api/files/move', { path: 'm2.md', newParentDir: '有m2' })).status).toBe(409)
  })

  it('文件夹重命名成功（含子文件路径随之变化）', async () => {
    fs.mkdirSync(path.join(NOTES, '改名目录'), { recursive: true })
    fs.writeFileSync(path.join(NOTES, '改名目录', '内.md'), '# 内')
    const res = await api('POST', '/api/files/rename', {
      path: '改名目录',
      newName: '新目录名',
    })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(NOTES, '新目录名', '内.md'))).toBe(true)
  })

  it('各接口缺参/空参分支', async () => {
    expect((await api('GET', '/api/files/content')).status).toBe(400) // 无 path
    expect((await api('POST', '/api/files', { name: '仅名' })).status).toBe(201) // parentDir/type 缺省
    expect((await api('POST', '/api/files/rename', { path: '仅名.md' })).status).toBe(400)
    expect((await api('POST', '/api/files/move', { path: '仅名.md' })).status).toBe(400)
    expect((await api('POST', '/api/export/pdf', { path: '' })).status).toBe(400)
  })

  it('带 .md 后缀创建不重复补后缀', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '自带.md' })
    expect(((await res.json()) as { path: string }).path).toBe('自带.md')
  })
})

describe('主题接口分支', () => {
  it('非法主题文件名 400（路径分隔/特殊字符）', async () => {
    expect((await api('GET', '/api/themes/..%2Fevil.css')).status).toBe(400)
    expect((await api('GET', '/api/themes/空格 名.css')).status).toBe(404) // 合法名但不存在
    expect((await api('GET', '/api/themes/notexist.css')).status).toBe(404)
  })
})

describe('协同钩子分支', () => {
  it('onLoadDocument：文件不存在 → 空树 + 基线 null', async () => {
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '不存在.md' } as never)
    expect(doc.getXmlFragment('prosemirror').length).toBe(0)
  })

  it('onLoadDocument：非空协同树不重复播种', async () => {
    fs.writeFileSync(path.join(NOTES, '钩子b.md'), '# B\n')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# 已有内容\n'))
    await collabHooks.onLoadDocument!({ document: doc, documentName: '钩子b.md' } as never)
    const xml = doc.getXmlFragment('prosemirror').toString()
    expect(xml).toContain('已有内容')
    expect(xml).not.toContain('# B')
  })

  it('onStoreDocument：内容未变时跳过写盘（mtime 不变）', async () => {
    fs.writeFileSync(path.join(NOTES, '钩子c.md'), '# C\n')
    ensureState('钩子c.md')
    recordDiskBaseline('钩子c.md')
    const before = fs.statSync(path.join(NOTES, '钩子c.md')).mtimeMs
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# C\n'))
    await collabHooks.onStoreDocument!({ document: doc, documentName: '钩子c.md' } as never)
    expect(fs.statSync(path.join(NOTES, '钩子c.md')).mtimeMs).toBe(before)
  })

  it('onStoreDocument：文件消失 → 下线并广播 doc-gone', async () => {
    const gone = '钩子gone.md'
    fs.writeFileSync(path.join(NOTES, gone), '# G\n')
    ensureState(gone)
    const doc = new Y.Doc()
    const name = relToDocName(gone)
    hocuspocus.documents.set(name, doc as never)
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})
    try {
      fs.rmSync(path.join(NOTES, gone))
      await collabHooks.onStoreDocument!({ document: doc, documentName: gone } as never)
      expect(closeSpy).toHaveBeenCalledWith(name)
      expect(unloadSpy).toHaveBeenCalled()
    } finally {
      hocuspocus.documents.delete(name)
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
    }
  })

  it('onStoreDocument：正常路径写盘 + 哈希更新', async () => {
    fs.writeFileSync(path.join(NOTES, '钩子d.md'), '# D 旧\n')
    ensureState('钩子d.md')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# D 新\n'))
    await collabHooks.onStoreDocument!({ document: doc, documentName: '钩子d.md' } as never)
    expect(fs.readFileSync(path.join(NOTES, '钩子d.md'), 'utf8')).toContain('D 新')
  })

  it('retireDoc：在线文档被冲刷下线，离线文档安全无操作', async () => {
    const doc = new Y.Doc()
    hocuspocus.documents.set('钩子e.md', doc as never)
    const flushSpy = vi.spyOn(hocuspocus, 'flushPendingStores').mockImplementation(() => {})
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})
    try {
      await retireDoc('钩子e.md')
      expect(flushSpy).toHaveBeenCalled()
      expect(closeSpy).toHaveBeenCalledWith('钩子e.md')
      await retireDoc('从未在线.md') // 无 documents 条目 → 直接清理状态
    } finally {
      hocuspocus.documents.delete('钩子e.md')
      flushSpy.mockRestore()
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
    }
  })
})
