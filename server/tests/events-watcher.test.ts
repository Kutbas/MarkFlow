/**
 * SSE 事件枢纽 + Chokidar 文件监听 + 外部改动同步（externalSync）覆盖。
 * externalSync 通过把真实 Y.Doc 塞进 hocuspocus.documents 驱动（无需真实连接）。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { startExternalSync } from '../src/collab/externalSync.js'
import { startNoteWatcher, onNoteEvent, type NoteEvent } from '../src/files/watcher.js'
import {
  relToDocName,
  recordDiskBaseline,
  ensureState,
} from '../src/collab/docRegistry.js'
import { mdToUpdate } from '../src/interop/index.js'

const NOTES = process.env.NOTES_DIR!

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
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('SSE 事件流', () => {
  it('订阅后能收到广播事件', async () => {
    const { sseHub } = await import('../src/events.js')
    const res = await fetch(`${base}/api/events`, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const first = await reader.read() // ": connected"
    expect(new TextDecoder().decode(first.value!)).toContain('connected')

    sseHub.broadcast('tree', { reason: 'add', path: 'x.md' })
    const deadline = Date.now() + 5000
    let got = ''
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('读超时')), 4000)),
      ])
      got += new TextDecoder().decode(chunk.value ?? new Uint8Array())
      if (got.includes('event: tree')) break
    }
    expect(got).toContain('event: tree')
    expect(got).toContain('"path":"x.md"')
    await reader.cancel()
  })

  it('未登录禁止订阅 SSE', async () => {
    const res = await fetch(`${base}/api/events`)
    expect(res.status).toBe(401)
  })
})

describe('Chokidar 文件监听', () => {
  it('add/change/unlink/unlinkDir 事件与隐藏文件忽略', async () => {
    const events: NoteEvent[] = []
    const off = onNoteEvent((e) => events.push(e))
    const watcher = startNoteWatcher()

    const waitEvent = (pred: (e: NoteEvent) => boolean, ms = 5000) =>
      new Promise<NoteEvent>((resolve, reject) => {
        const t = setInterval(() => {
          const hit = events.find(pred)
          if (hit) {
            clearInterval(t)
            resolve(hit)
          }
        }, 50)
        setTimeout(() => {
          clearInterval(t)
          reject(new Error('等事件超时: ' + JSON.stringify(events)))
        }, ms)
      })

    try {
      fs.writeFileSync(path.join(NOTES, '监听a.md'), '# a\n')
      // awaitWriteFinish 会合并短时间内的建+写，首事件可能是 add 或 change
      await waitEvent((e) => e.relPath === '监听a.md' && e.kind !== 'unlink')
      fs.writeFileSync(path.join(NOTES, '监听a.md'), '# a 改\n')
      await waitEvent((e) => e.kind === 'change' && e.relPath === '监听a.md')
      fs.writeFileSync(path.join(NOTES, '.DS_Store'), 'junk')
      fs.mkdirSync(path.join(NOTES, '监听目录'))
      fs.writeFileSync(path.join(NOTES, '监听目录', '内.md'), '# 内')
      await waitEvent((e) => e.kind === 'add' && e.relPath === '监听目录/内.md')
      fs.rmSync(path.join(NOTES, '监听目录'), { recursive: true })
      await waitEvent((e) => e.kind === 'unlink' && e.relPath === '监听目录')
      fs.rmSync(path.join(NOTES, '监听a.md'))
      await waitEvent((e) => e.kind === 'unlink' && e.relPath === '监听a.md')
      expect(events.some((e) => e.relPath.includes('DS_Store'))).toBe(false)
    } finally {
      off()
      await watcher.close()
    }
  }, 15000)
})

describe('externalSync 外部改动同步', () => {
  it('在线文档被外部重置 / 回声抑制 / 离线忽略 / unlink 下线', async () => {
    const { hocuspocus } = await import('../src/collab/hocuspocus.js')
    const file = '外部同步测试.md'
    const docName = relToDocName(file)
    const abs = path.join(NOTES, file)
    fs.writeFileSync(abs, '# 旧内容\n')
    ensureState(file)
    recordDiskBaseline(file)

    // 真实 Y.Doc 伪装成在线文档（跳过网络层）
    const fakeDoc = new Y.Doc()
    Y.applyUpdate(fakeDoc, await mdToUpdate('# 旧内容\n'))
    hocuspocus.documents.set(docName, fakeDoc as never)
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const unloadSpy = vi.spyOn(hocuspocus, 'unloadDocument').mockImplementation(async () => {})

    const watcher = startNoteWatcher() // externalSync 依赖文件监听事件
    startExternalSync()
    try {
      fs.writeFileSync(abs, '# 新内容（外部 vim 改）\n')
      await waitFor(() => fakeDoc.getXmlFragment('prosemirror').toString().includes('新内容'))
      expect(fakeDoc.getXmlFragment('prosemirror').toString()).not.toContain('旧内容')

      // 回声抑制：写相同内容 → 哈希与基线一致 → 不触发重置
      const before = fakeDoc.getXmlFragment('prosemirror').toString()
      fs.writeFileSync(abs, '# 新内容（外部 vim 改）\n')
      await new Promise((r) => setTimeout(r, 800))
      expect(fakeDoc.getXmlFragment('prosemirror').toString()).toBe(before)

      // 离线：从 documents 移除后改动不影响任何文档（不抛错即可）
      hocuspocus.documents.delete(docName)
      fs.writeFileSync(abs, '# 又改了\n')
      await new Promise((r) => setTimeout(r, 500))

      // unlink：在线文档被下线（含 spy 断言）
      hocuspocus.documents.set(docName, fakeDoc as never)
      fs.rmSync(abs)
      await new Promise((r) => setTimeout(r, 800))
      expect(closeSpy).toHaveBeenCalledWith(docName)
      expect(unloadSpy).toHaveBeenCalled()
    } finally {
      hocuspocus.documents.delete(docName)
      closeSpy.mockRestore()
      unloadSpy.mockRestore()
      await watcher.close()
    }
  }, 15000)
})

function waitFor(probe: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (probe()) {
        clearInterval(t)
        resolve()
      }
    }, 50)
    setTimeout(() => {
      clearInterval(t)
      reject(new Error('waitFor 超时'))
    }, ms)
  })
}
