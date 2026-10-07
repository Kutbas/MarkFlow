/**
 * PG 模式协同端到端（pglite）：登录 → 双端协同 → 防抖落库（Yjs 权威状态）→
 * 状态恢复（重启模拟）→ 导出 md。存储通过 setStorageOverride 注入。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket as WS } from 'ws'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { hocuspocus } from '../src/collab/hocuspocus.js'
import { attachCollab } from '../src/collab/ws.js'
import { issueToken } from '../src/auth/service.js'
import { setStorageOverride } from '../src/storage/index.js'
import { PgAdapter } from '../src/storage/pg-adapter.js'

const SEEDS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seeds/notes')

const g = globalThis as unknown as { __pgAdapter: unknown }

let server: http.Server
let base: string
let cookie = ''

class AuthedWS extends WS {
  constructor(url: string) {
    super(url.replace(/^http/, 'ws'), { headers: { Cookie: cookie } })
  }
}

function connect(docName: string) {
  return new HocuspocusProvider({
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/collab`,
    name: docName,
    WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
}

beforeAll(async () => {
  server = http.createServer(createApp())
  attachCollab(server, hocuspocus)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cookie = `mf_token=${await issueToken('alice')}`
})
afterAll(async () => {
  // unloadImmediately:false 会让 destroy 等防抖——竞速超时兜底
  const race = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))])
  for (const name of [...hocuspocus.documents.keys()]) {
    hocuspocus.closeConnections(name)
  }
  await race(Promise.resolve((hocuspocus as unknown as { destroy?: () => Promise<void> }).destroy?.()), 3000)
  server.closeAllConnections?.()
  await race(new Promise<void>((r) => server.close(() => r)), 3000)
}, 15_000)

function docXml(ydoc: Y.Doc): string {
  return ydoc.getXmlFragment('prosemirror').toString()
}

function waitFor(probe: () => boolean, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (probe()) { clearInterval(t); resolve() }
    }, 60)
    setTimeout(() => { clearInterval(t); reject(new Error('waitFor 超时')) }, ms)
  })
}

it('PG 全链路：播种 → 双端协同 → 落库 → 状态恢复（重启模拟）→ 导出 md', async () => {
  // 1) 树来自数据库
  const tree = await fetch(`${base}/api/files/tree`, { headers: { Cookie: cookie } })
  const { tree: nodes } = (await tree.json()) as { tree: { path: string }[] }
  expect(nodes.some((n) => n.path === '欢迎使用 MarkFlow.md')).toBe(true)

  // 2) 双端协同 + 编辑落库
  const a = connect('欢迎使用 MarkFlow.md')
  const b = connect('欢迎使用 MarkFlow.md')
  await waitFor(() => docXml(a.document).includes('欢迎使用 MarkFlow'))
  await waitFor(() => docXml(b.document).includes('欢迎使用 MarkFlow'))
  a.document.transact(() => {
    const first = a.document.getXmlFragment('prosemirror').firstChild as Y.XmlElement
    const text = first.toArray().find((c) => c && typeof (c as Y.XmlText).insert === 'function') as Y.XmlText
    text.delete(0, text.length)
    text.insert(0, 'PG 重写标题')
  })
  await waitFor(() => docXml(b.document).includes('PG 重写标题'))
  // 防抖落库（1.5s + 余量）
  await new Promise((r) => setTimeout(r, 2600))

  // 3) 导出 md 反映新内容
  const mdRes = await fetch(
    `${base}/api/export/md?path=${encodeURIComponent('欢迎使用 MarkFlow.md')}`,
    { headers: { Cookie: cookie } },
  )
  expect(mdRes.status).toBe(200)
  expect(await mdRes.text()).toContain('PG 重写标题')

  // 4) 状态恢复：模拟重启（清 hocuspocus 文档缓存）→ 新连接拿回权威状态
  for (const name of [...hocuspocus.documents.keys()]) {
    hocuspocus.closeConnections(name)
    await hocuspocus.unloadDocument(hocuspocus.documents.get(name)!)
  }
  const c = connect('欢迎使用 MarkFlow.md')
  await waitFor(() => docXml(c.document).includes('PG 重写标题'))
  expect(docXml(c.document)).not.toContain('欢迎使用 MarkFlow</heading>')

  a.destroy(); b.destroy(); c.destroy()
}, 30_000)

it('导出 md 参数校验', async () => {
  expect((await fetch(`${base}/api/export/md`, { headers: { Cookie: cookie } })).status).toBe(400)
  expect(
    (await fetch(`${base}/api/export/md?path=${encodeURIComponent('../x.md')}`, { headers: { Cookie: cookie } })).status,
  ).toBe(400)
  expect(
    (await fetch(`${base}/api/export/md?path=${encodeURIComponent('不存在.md')}`, { headers: { Cookie: cookie } })).status,
  ).toBe(404)
  expect((await fetch(`${base}/api/export/md?path=x.md`)).status).toBe(401)
})
