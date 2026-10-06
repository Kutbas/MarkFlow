import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../src/api/client'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('api client', () => {
  it('成功返回解析后的 JSON', async () => {
    const fn = stubFetch(200, { user: 'alice' })
    expect(await api.me()).toEqual({ user: 'alice' })
    expect(fn).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ method: 'GET' }))
  })

  it('业务错误 → ApiError 携带服务端 error 消息', async () => {
    stubFetch(409, { error: '同名文件已存在' })
    await expect(api.createFile('', 'dup')).rejects.toThrow('同名文件已存在')
    try {
      await api.createFile('', 'dup')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(409)
    }
  })

  it('响应体非 JSON 时也能抛出 ApiError（状态码保留）', async () => {
    const fn = vi.fn(async () => new Response('<html>', { status: 500, statusText: 'Oops' }))
    vi.stubGlobal('fetch', fn)
    await expect(api.tree()).rejects.toThrow('Oops')
    try {
      await api.tree()
    } catch (e) {
      expect((e as ApiError).status).toBe(500)
    }
  })

  it('401 触发全局 unauthorized 事件（供 App 退出登录）', async () => {
    stubFetch(401, { error: '未登录' })
    const handler = vi.fn()
    window.addEventListener('mf:unauthorized', handler)
    await api.tree().catch(() => {})
    expect(handler).toHaveBeenCalled()
    window.removeEventListener('mf:unauthorized', handler)
  })

  it('CRUD 方法透传正确的 method 与 body', async () => {
    const fn = stubFetch(200, { ok: true })
    await api.rename('a.md', 'b.md')
    const [, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toContain('"newName":"b.md"')

    await api.remove('a.md')
    const [, init2] = fn.mock.calls[1] as [string, RequestInit]
    expect(String(fn.mock.calls[1][0])).toContain('/api/files/delete')
    expect(init2.method).toBe('POST')
  })
})
