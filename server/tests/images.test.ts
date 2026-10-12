/** 本地图片上传/读取：MIME 白名单、二进制落库、读取回原内容 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

let server: http.Server
let base: string
let cookie = ''

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
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 1x1 PNG */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
  0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00,
  0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

describe('图片上传', () => {
  it('未登录禁止上传/读取', async () => {
    const post = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_BYTES,
    })
    expect(post.status).toBe(401)
  })

  it('上传 png → 返回 /api/images/ url → 读取回原字节与 MIME', async () => {
    const up = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Cookie: cookie },
      body: PNG_BYTES,
    })
    expect(up.status).toBe(201)
    const { url } = (await up.json()) as { url: string }
    expect(url).toMatch(/^\/api\/images\/[a-f0-9-]+\.png$/)

    const get = await fetch(`${base}${url}`, { headers: { Cookie: cookie } })
    expect(get.status).toBe(200)
    expect(get.headers.get('content-type')).toBe('image/png')
    expect(get.headers.get('cache-control')).toContain('immutable')
    const back = new Uint8Array(await get.arrayBuffer())
    expect(back.length).toBe(PNG_BYTES.length)
    expect(Buffer.from(back).equals(Buffer.from(PNG_BYTES))).toBe(true)
  })

  it('非图片 MIME 拒绝（415）', async () => {
    const res = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html', Cookie: cookie },
      body: '<script>x</script>',
    })
    expect(res.status).toBe(415)
  })

  it('svg 不在白名单（防脚本注入）', async () => {
    const res = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/svg+xml', Cookie: cookie },
      body: '<svg onload="alert(1)"></svg>',
    })
    expect(res.status).toBe(415)
  })

  it('不存在的 id 返回 404；非法 id 不触发查询异常', async () => {
    const a = await fetch(`${base}/api/images/00000000-0000-0000-0000-000000000000.png`, {
      headers: { Cookie: cookie },
    })
    expect(a.status).toBe(404)
    const b = await fetch(`${base}/api/images/..%2Fdoc_state`, { headers: { Cookie: cookie } })
    expect(b.status).toBe(404)
  })
})
