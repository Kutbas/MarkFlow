import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

let server: http.Server
let base: string
let cookie = ''

const g = globalThis as unknown as { __pgAdapter: { createFile(p: string, md: string): Promise<void>; createFolder(p: string): Promise<void>; exists(p: string): Promise<boolean>; remove(p: string): Promise<void>; readMarkdown(p: string): Promise<string> } }

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('监听失败')
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function api(method: string, url: string, body?: unknown, useCookie = true): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(useCookie && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeAll(async () => {
  const res = await api('POST', '/api/auth/login', { name: 'alice', password: 'alice123' }, false)
  expect(res.status).toBe(200)
  cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  expect(cookie).toMatch(/^mf_token=/)
  // 基线数据
  await g.__pgAdapter.createFile('首页.md', '# 首页\n\n你好 MarkFlow\n').catch(() => {})
  await g.__pgAdapter.createFolder('子目录').catch(() => {})
  await g.__pgAdapter.createFile('子目录/笔记.md', '# 笔记\n').catch(() => {})
})

describe('鉴权', () => {
  it('健康检查无需登录', async () => {
    expect((await api('GET', '/api/health', undefined, false)).status).toBe(200)
  })
  it('未登录 401', async () => {
    expect((await api('GET', '/api/files/tree', undefined, false)).status).toBe(401)
  })
  it('错误密码 401', async () => {
    expect((await api('POST', '/api/auth/login', { name: 'alice', password: 'wrong' }, false)).status).toBe(401)
  })
  it('me 返回当前用户', async () => {
    expect(await (await api('GET', '/api/auth/me')).json()).toEqual({ user: 'alice' })
  })
})

describe('登录态续命（滑动续期 + ws-token）', () => {
  it('ws-token：未登录 401；登录后返回短寿命 ws 用途 token', async () => {
    expect((await api('GET', '/api/auth/ws-token', undefined, false)).status).toBe(401)
    const res = await api('GET', '/api/auth/ws-token')
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const { verifyTokenPayload } = await import('../src/auth/service.js')
    const payload = await verifyTokenPayload(token)
    expect(payload?.name).toBe('alice')
    expect(payload?.purpose).toBe('ws')
    expect(payload!.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
  })

  it('ws-token 不作为会话凭证续期 cookie（短寿命不滑动）', async () => {
    const res = await api('GET', '/api/auth/ws-token')
    const { token } = (await res.json()) as { token: string }
    const withWs = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `mf_token=${token}` } })
    expect(await withWs.json()).toEqual({ user: 'alice' })
    // ws 短寿命 token 命中续期逻辑应被跳过：无 Set-Cookie
    expect(withWs.headers.getSetCookie().some((c) => c.startsWith('mf_token='))).toBe(false)
  })

  it('新鲜 token 请求不重签 cookie；近过期 token 触发滑动续期', async () => {
    const { issueToken } = await import('../src/auth/service.js')
    // 新鲜（默认 7 天 > 半衰）：任何 API 调用都不重签
    const freshRes = await api('GET', '/api/auth/me')
    expect(freshRes.headers.getSetCookie().some((c) => c.startsWith('mf_token='))).toBe(false)
    // 近过期（剩余 100s < 3.5 天）：requireAuth / me 均应重签
    const stale = await issueToken('alice', { ttlSeconds: 100 })
    for (const url of ['/api/auth/me', '/api/files/tree']) {
      const res = await fetch(`${base}${url}`, { headers: { Cookie: `mf_token=${stale}` } })
      expect(res.status).toBe(200)
      const set = res.headers.getSetCookie().find((c) => c.startsWith('mf_token='))
      expect(set).toBeTruthy()
      // 重签的是新 7 天 token（值 ≠ 原值）
      expect(set).not.toBe(`mf_token=${stale}`)
    }
  })
})

describe('文件树与 CRUD', () => {
  it('读取目录树', async () => {
    const { tree } = (await (await api('GET', '/api/files/tree')).json()) as {
      tree: { path: string }[]
    }
    expect(tree.map((n) => n.path)).toContain('子目录')
    expect(tree.map((n) => n.path)).toContain('首页.md')
  })

  it('新建文件自动补 .md', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '新文档', type: 'file' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { path: string }).path).toBe('新文档.md')
    expect(await g.__pgAdapter.exists('新文档.md')).toBe(true)
  })

  it('新建文件带 initialMd（导入）：内容原样落库', async () => {
    const md = '# 导入的文档\n\n含 **加粗** 与表格：\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const res = await api('POST', '/api/files', {
      parentDir: '',
      name: '导入测试.md',
      type: 'file',
      initialMd: md,
    })
    expect(res.status).toBe(201)
    const stored = await g.__pgAdapter.readMarkdown('导入测试.md')
    expect(stored).toBe(md)
  })

  it('新建文件 initialMd 缺省时回落标题模板', async () => {
    await api('POST', '/api/files', { parentDir: '', name: '模板回落', type: 'file' })
    expect(await g.__pgAdapter.readMarkdown('模板回落.md')).toBe('# 模板回落\n\n')
  })

  it('新建文件夹', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '项目', type: 'folder' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { path: string }).path).toBe('项目')
  })

  it('docsize 返回文档数据量', async () => {
    const res = await api('GET', '/api/files/docsize?path=' + encodeURIComponent('首页.md'))
    expect(res.status).toBe(200)
    const { size } = (await res.json()) as { size: number }
    expect(typeof size).toBe('number')
    expect(size).toBeGreaterThan(0)
  })

  it('读取文件内容', async () => {
    const res = await api('GET', '/api/files/content?path=' + encodeURIComponent('首页.md'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { content: string }).content).toContain('你好 MarkFlow')
  })

  it('重命名', async () => {
    expect((await api('POST', '/api/files/rename', { path: '首页.md', newName: '主页.md' })).status).toBe(200)
    expect(await g.__pgAdapter.exists('主页.md')).toBe(true)
  })

  it('移动到子目录', async () => {
    const res = await api('POST', '/api/files/move', { path: '新文档.md', newParentDir: '子目录' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { path: string }).path).toBe('子目录/新文档.md')
    expect(await g.__pgAdapter.exists('子目录/新文档.md')).toBe(true)
  })

  it('禁止移动文件夹到自身内部', async () => {
    expect((await api('POST', '/api/files/move', { path: '子目录', newParentDir: '子目录' })).status).toBe(400)
  })

  it('删除文件', async () => {
    expect((await api('POST', '/api/files/delete', { path: '子目录/新文档.md' })).status).toBe(200)
    expect(await g.__pgAdapter.exists('子目录/新文档.md')).toBe(false)
  })
})

describe('路径穿越攻击（经 API 层）', () => {
  it.each([
    ['../../etc/passwd', 'GET', '/api/files/content?path=..%2F..%2Fetc%2Fpasswd'],
    ['绝对路径', 'GET', '/api/files/content?path=%2Fetc%2Fpasswd'],
    ['null byte', 'GET', '/api/files/content?path=a%00b.md'],
  ])('拦截 %s', async (_name, method, url) => {
    const res = await api(method, url)
    expect([400, 404]).toContain(res.status)
  })
  it('穿越新建被拦截', async () => {
    expect((await api('POST', '/api/files', { parentDir: '../..', name: 'evil.md' })).status).toBe(400)
  })
})

describe('主题接口', () => {
  it('主题列表', async () => {
    const { themes } = (await (await api('GET', '/api/themes')).json()) as {
      themes: { name: string }[]
    }
    expect(themes.map((t: { name: string }) => t.name)).toContain('demo')
  })
  it('下发 CSS', async () => {
    const res = await api('GET', '/api/themes/demo.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })
})
