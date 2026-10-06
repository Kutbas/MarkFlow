import './helpers/env.js'
// 先设环境变量再导入业务模块（含 shared 无头转换器）
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { WebSocket as WS, type RawData } from 'ws'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { createApp } from '../src/app.js'
import { hocuspocus, retireDoc } from '../src/collab/hocuspocus.js'
import { attachCollab } from '../src/collab/ws.js'
import { startExternalSync } from '../src/collab/externalSync.js'
import { startNoteWatcher } from '../src/files/watcher.js'
import { getHeadless } from '@markflow/shared/headless'
import { yDocToMd } from '../src/interop/index.js'

let server: http.Server
let base: string
let wsBase: string
let cookie = ''

const NOTES = process.env.NOTES_DIR!

/** 带鉴权 Cookie 的 WebSocket polyfill（Node 环境模拟浏览器行为） */
class AuthedWebSocket extends WS {
  constructor(url: string) {
    super(url.replace(/^http/, 'ws'), {
      headers: { Cookie: cookie },
    })
  }
}

beforeAll(async () => {
  server = http.createServer(createApp())
  attachCollab(server, hocuspocus)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
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
  console.log('[beforeAll] login =', res.status, 'cookie 长度 =', cookie.length)

  startNoteWatcher()
  startExternalSync()
})

let liveProviders: HocuspocusProvider[] = []

afterAll(async () => {
  for (const p of liveProviders) p.destroy()
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function connect(docName: string): HocuspocusProvider {
  const p = new HocuspocusProvider({
    url: wsBase,
    name: docName,
    WebSocketPolyfill: AuthedWebSocket as unknown as typeof WebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  liveProviders.push(p)
  p.on('status', (e: unknown) => console.log(`[${docName} status]`, JSON.stringify(e)))
  p.on('synced', () => console.log(`[${docName} synced]`))
  p.on('authenticationFailed', (e: unknown) => console.log(`[${docName} authFailed]`, JSON.stringify(e)))
  return p
}

function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let lastLog = 0
    const timer = setInterval(() => {
      const value = probe()
      if (value !== undefined) {
        clearInterval(timer)
        resolve(value)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error('等待超时'))
      } else if (Date.now() - lastLog > 1500) {
        lastLog = Date.now()
        console.log('[waitFor 探测中]', new Error().stack?.split('\n')[2]?.trim(), `已等 ${((Date.now() - start) / 1000).toFixed(1)}s`)
      }
    }, 60)
  })
}

/** 协同树的 XML 字符串形态（如 `<heading id="" level="1">文本</heading>`） */
function docXml(ydoc: Y.Doc): string {
  return ydoc.getXmlFragment('prosemirror').toString()
}

/** 首个块节点（标题/段落）内的文本编辑句柄（duck-typing，避免 instanceof 跨实例问题） */
interface TextHandle {
  length: number
  delete: (index: number, len: number) => void
  insert: (index: number, content: string) => void
}
function firstTextHandle(ydoc: Y.Doc): TextHandle | null {
  const first = ydoc.getXmlFragment('prosemirror').firstChild as Y.XmlElement | null
  if (!first) return null
  for (const child of first.toArray()) {
    if (
      child &&
      typeof child === 'object' &&
      'delete' in child &&
      'insert' in child &&
      'length' in child
    ) {
      return child as unknown as TextHandle
    }
  }
  return null
}

it('全链路：登录 → 双端协同 → 防抖落盘 → 外部改动重置', async () => {
  // 准备一篇已知内容的文档
  fs.writeFileSync(path.join(NOTES, '协同测试.md'), '# 原始标题\n\n第一段内容\n')
  await retireDoc('协同测试.md')

  // 双端连接
  const providerA = connect('协同测试.md')
  const providerB = connect('协同测试.md')

  // 双端都能读到磁盘内容（onLoadDocument 播种）
  await new Promise((r) => setTimeout(r, 2500))
  console.log('RAW A xml:', docXml(providerA.document).slice(0, 200))
  console.log('RAW B xml:', docXml(providerB.document).slice(0, 200))
  expect(docXml(providerA.document)).toContain('原始标题')
  expect(docXml(providerB.document)).toContain('原始标题')

  // A 端修改标题 → 毫秒级同步到 B 端（CRDT 合并）
  providerA.document.transact(() => {
    const text = firstTextHandle(providerA.document)
    if (!text) throw new Error('找不到标题文本节点')
    text.delete(0, text.length)
    text.insert(0, 'A 改的新标题')
  })
  // 等待中继传播 + 防抖落盘（停止输入 1.5s 后写盘，留足余量）
  await new Promise((r) => setTimeout(r, 4000))
  console.log('编辑后 B xml:', docXml(providerB.document).slice(0, 200))
  expect(docXml(providerB.document)).toContain('A 改的新标题')

  // 防抖落盘：磁盘应有新内容
  const flushed = fs.readFileSync(path.join(NOTES, '协同测试.md'), 'utf8')
  expect(flushed).toContain('A 改的新标题')
  expect(flushed).toMatch(/^# A 改的新标题/)

  // 外部改动：直接覆写磁盘 → 在线文档被重置为新内容
  fs.writeFileSync(path.join(NOTES, '协同测试.md'), '# 外部改的标题\n')
  await waitFor(() =>
    docXml(providerA.document).includes('外部改的标题') ? true : undefined,
  )
  expect(docXml(providerB.document)).toContain('外部改的标题')

  providerA.destroy()
  providerB.destroy()
}, 30_000)

it('未登录的 WebSocket 连接无法同步任何文档', async () => {
  fs.writeFileSync(path.join(NOTES, '权限测试.md'), '# 权限\n')
  let synced = false
  const evil = new HocuspocusProvider({
    url: wsBase,
    name: '权限测试.md',
    WebSocketPolyfill: class extends WS {
      constructor(url: string) {
        super(url.replace(/^http/, 'ws'), {
          headers: { Cookie: 'mf_token=invalid-token' },
        })
      }
    } as unknown as typeof WebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0])
  liveProviders.push(evil)
  evil.on('synced', () => {
    synced = true
  })
  await new Promise((r) => setTimeout(r, 4000))
  expect(synced).toBe(false)
  expect(evil.document.getXmlFragment('prosemirror').length).toBe(0)
}, 10_000)

it('interop：Y 文档序列化为标准 Markdown（供落盘）', async () => {
  const { prosemirrorToYDoc } = await import('y-prosemirror')
  const { parse } = await getHeadless()
  const md = '# 标题\n\n- [x] 任务\n\n$$\nE=mc^2\n$$\n'
  const ydoc = prosemirrorToYDoc(parse(md))
  const out = await yDocToMd(ydoc)
  expect(out).toContain('# 标题')
  expect(out).toContain('[x] 任务')
  expect(out).toContain('$$')
})
