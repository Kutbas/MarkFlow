import http from 'node:http'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { WebSocket as WS } from 'ws'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { hocuspocus, retireDoc } from '../src/collab/hocuspocus.js'
import { attachCollab } from '../src/collab/ws.js'
import { getHeadless } from '@markflow/shared/headless'
import { yDocToMd } from '../src/interop/index.js'

type Ad = { createFile(p: string, md: string): Promise<void>; readMarkdown(p: string): Promise<string>; remove(p: string): Promise<void> }
const g = globalThis as unknown as { __pgAdapter: Ad }

let server: http.Server
let base: string
let wsBase: string
let cookie = ''

class AuthedWebSocket extends WS {
  constructor(url: string) {
    super(url.replace(/^http/, 'ws'), { headers: { Cookie: cookie } })
  }
}

beforeAll(async () => {
  server = http.createServer(createApp())
  attachCollab(server, hocuspocus)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('监听失败')
  base = `http://127.0.0.1:${addr.port}`
  wsBase = `ws://127.0.0.1:${addr.port}/collab`
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'alice123' }),
  })
  cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
})

afterAll(async () => {
  const race = <T>(p: Promise<T>, ms: number) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))])
  for (const name of [...hocuspocus.documents.keys()]) hocuspocus.closeConnections(name)
  await race(Promise.resolve((hocuspocus as unknown as { destroy?: () => Promise<void> }).destroy?.()), 3000)
  server.closeAllConnections?.()
  await race(new Promise<void>((r) => server.close(() => r)), 3000)
})

function connect(docName: string) {
  return new HocuspocusProvider({
    url: wsBase,
    name: docName,
    WebSocketPolyfill: AuthedWebSocket as unknown as typeof WebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
}

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

it('全链路：播种 → 双端协同 → 防抖落库(PG) → 权威状态恢复', async () => {
  await g.__pgAdapter.createFile('协同测试.md', '# 原始标题\n\n第一段内容\n').catch(() => {})
  await retireDoc('协同测试.md')

  const providerA = connect('协同测试.md')
  const providerB = connect('协同测试.md')

  await waitFor(() => docXml(providerA.document).includes('原始标题'))
  await waitFor(() => docXml(providerB.document).includes('原始标题'))
  expect(docXml(providerA.document)).toContain('<heading')

  // A 改标题 → B 毫秒级收到（CRDT 合并）
  providerA.document.transact(() => {
    const first = providerA.document.getXmlFragment('prosemirror').firstChild as Y.XmlElement
    const text = first.toArray().find((c) => c && typeof (c as Y.XmlText).insert === 'function') as Y.XmlText
    text.delete(0, text.length)
    text.insert(0, 'A 改的新标题')
  })
  await waitFor(() => docXml(providerB.document).includes('A 改的新标题'))

  // 防抖落库：md 缓存反映新内容
  await new Promise((r) => setTimeout(r, 2600))
  const flushed = await g.__pgAdapter.readMarkdown('协同测试.md')
  expect(flushed).toMatch(/^# A 改的新标题/)

  // 权威状态恢复：清协同缓存（模拟重启）→ 新连接直接拿回 CRDT 身份
  for (const name of [...hocuspocus.documents.keys()]) {
    hocuspocus.closeConnections(name)
    await hocuspocus.unloadDocument(hocuspocus.documents.get(name)!)
  }
  const c = connect('协同测试.md')
  await waitFor(() => docXml(c.document).includes('A 改的新标题'))
  expect(docXml(c.document)).not.toContain('原始标题')

  providerA.destroy(); providerB.destroy(); c.destroy()
}, 30_000)

it('未登录的 WebSocket 连接无法同步任何文档', async () => {
  await g.__pgAdapter.createFile('权限测试.md', '# 权限\n').catch(() => {})
  let synced = false
  const evil = new HocuspocusProvider({
    url: wsBase,
    name: '权限测试.md',
    WebSocketPolyfill: class extends WS {
      constructor(url: string) {
        super(url.replace(/^http/, 'ws'), { headers: { Cookie: 'mf_token=invalid-token' } })
      }
    } as unknown as typeof WebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  evil.on('synced', () => { synced = true })
  await new Promise((r) => setTimeout(r, 4000))
  expect(synced).toBe(false)
  expect(evil.document.getXmlFragment('prosemirror').length).toBe(0)
  evil.destroy()
}, 10_000)

it('interop：Y 文档序列化为标准 Markdown', async () => {
  const { prosemirrorToYDoc } = await import('y-prosemirror')
  const { parse } = await getHeadless()
  const md = '# 标题\n\n- [x] 任务\n\n$$\nE=mc^2\n$$\n'
  const ydoc = prosemirrorToYDoc(parse(md))
  const out = await yDocToMd(ydoc)
  expect(out).toContain('# 标题')
  expect(out).toContain('[x] 任务')
  expect(out).toContain('$$')
})
