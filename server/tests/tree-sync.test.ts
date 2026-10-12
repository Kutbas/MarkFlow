/** rename/move 的 SSE tree 广播（多端同步：B 端靠此事件刷新树并跟随路径） */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

let server: http.Server
let base: string
let cookie = ''

const g = globalThis as unknown as {
  __pgAdapter: { createFile(p: string, md: string): Promise<void>; createFolder(p: string): Promise<void> }
}

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('监听失败')
  base = `http://127.0.0.1:${addr.port}`

  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'alice123' }),
  })
  expect(res.status).toBe(200)
  cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  await g.__pgAdapter.createFile('bcast-a.md', '# a\n').catch(() => {})
  await g.__pgAdapter.createFolder('bcast-dir').catch(() => {})
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('树操作 SSE 广播', () => {
  it('rename 与 move 后广播携带 from/to', async () => {
    // 订阅事件流（保持打开）
    const res = await fetch(`${base}/api/events`, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()

    let got = ''
    const readUntil = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 5000
      while (!got.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`等待 ${needle} 超时，已收到:\n${got}`)
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('读超时')), 4000)),
        ])
        got += new TextDecoder().decode(chunk.value ?? new Uint8Array())
      }
    }

    // rename → tree 广播含 from/to
    const rn = await fetch(`${base}/api/files/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: 'bcast-a.md', newName: 'bcast-a2.md' }),
    })
    expect(rn.status).toBe(200)
    await readUntil('"reason":"rename"')
    expect(got).toContain('"from":"bcast-a.md"')
    expect(got).toContain('"to":"bcast-a2.md"')

    // move → tree 广播含 from/to
    const mv = await fetch(`${base}/api/files/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ path: 'bcast-a2.md', newParentDir: 'bcast-dir' }),
    })
    expect(mv.status).toBe(200)
    await readUntil('"reason":"move"')
    expect(got).toContain('"from":"bcast-a2.md"')
    expect(got).toContain('"to":"bcast-dir/bcast-a2.md"')

    await reader.cancel().catch(() => {})
  }, 15_000)
})
