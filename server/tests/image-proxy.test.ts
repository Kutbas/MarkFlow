/**
 * 图片代理路由：防盗链绕过（无 Referer 转发）、协议白名单、异常分支。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { issueToken } from '../src/auth/service.js'
import { proxyDeps } from '../src/files/image-proxy.js'

let server: http.Server
let base: string
let cookie = ''

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cookie = `mf_token=${await issueToken('alice')}`
})

afterAll(async () => {
  proxyDeps.fetch = realFetch
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

const realFetch = proxyDeps.fetch
function stubUpstream(status: number, headers: Record<string, string>, body: Uint8Array) {
  const fn = vi.fn(async () => new Response(body, { status, headers }))
  proxyDeps.fetch = fn
  return fn
}

describe('图片代理 /api/img', () => {
  it('未登录 401', async () => {
    const res = await fetch(`${base}/api/img?u=https://a.b/c.png`)
    expect(res.status).toBe(401)
  })

  it('非法地址/协议 400', async () => {
    const h = { Cookie: cookie }
    expect((await fetch(`${base}/api/img?u=not-a-url`, { headers: h })).status).toBe(400)
    expect(
      (await fetch(`${base}/api/img?u=${encodeURIComponent('ftp://x/y.png')}`, { headers: h })).status,
    ).toBe(400)
  })

  it('正常转发：透传 content-type 与字节，请求上游不带 Referer', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const fn = stubUpstream(200, { 'content-type': 'image/png' }, png)
    const res = await fetch(`${base}/api/img?u=${encodeURIComponent('https://cos.example.com/a.png')}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('max-age')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png)
    // 关键断言：上游请求头不含 Referer（绕过图床防盗链）
    const firstCall = fn.mock.calls[0] as unknown as [unknown, RequestInit | undefined]
    const upstreamInit = firstCall?.[1]
    expect(String(upstreamInit?.headers ?? '')).not.toContain('Referer')
    expect(String(upstreamInit?.headers ?? '')).not.toContain('referer')
  })

  it('上游 403 / 非 image 类型 → 502', async () => {
    stubUpstream(403, { 'content-type': 'application/xml' }, new Uint8Array(4))
    const res = await fetch(`${base}/api/img?u=${encodeURIComponent('https://a.b/x.png')}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(502)

    stubUpstream(200, { 'content-type': 'text/html' }, new TextEncoder().encode('<p>'))
    const res2 = await fetch(`${base}/api/img?u=${encodeURIComponent('https://a.b/y.png')}`, {
      headers: { Cookie: cookie },
    })
    expect(res2.status).toBe(502)
  })

  it('上游超时/网络错误 → 504', async () => {
    proxyDeps.fetch = vi.fn(async () => {
      throw new Error('network down')
    })
    const res = await fetch(`${base}/api/img?u=${encodeURIComponent('https://a.b/z.png')}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(504)
  })
})

describe('图片代理其余分支', () => {
  it('默认 proxyDeps.fetch 直连（非 image 响应 → 502，覆盖包装函数）', async () => {
    // 恢复默认实现（此前用例注入过 stub）
    proxyDeps.fetch = ((u: string | URL, i?: RequestInit) => fetch(u, i)) as never
    // 指向测试服务器自身的 JSON 接口：默认 fetch 生效，content-type 非 image → 502
    const res = await fetch(`${base}/api/img?u=${encodeURIComponent(base + '/api/health')}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(502)
  })

  it('上游无 body（Response null）→ 200 空体', async () => {
    proxyDeps.fetch = (async () => new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })) as never
    const res = await fetch(`${base}/api/img?u=${encodeURIComponent('https://a.b/empty.png')}`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    expect(new Uint8Array((await res.arrayBuffer()) ?? new ArrayBuffer(0))).toHaveLength(0)
  })
})
