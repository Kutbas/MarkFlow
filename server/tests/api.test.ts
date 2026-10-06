import './helpers/env.js'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
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
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function api(
  method: string,
  url: string,
  body?: unknown,
  useCookie = true,
): Promise<Response> {
  return fetch(`${base}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useCookie && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeAll(async () => {
  const res = await api('POST', '/api/auth/login', { name: 'alice', password: 'alice123' }, false)
  expect(res.status).toBe(200)
  cookie = (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
  expect(cookie).toMatch(/^mf_token=/)
})

describe('鉴权', () => {
  it('健康检查无需登录', async () => {
    const res = await api('GET', '/api/health', undefined, false)
    expect(res.status).toBe(200)
  })

  it('未登录访问业务 API 返回 401', async () => {
    const res = await api('GET', '/api/files/tree', undefined, false)
    expect(res.status).toBe(401)
  })

  it('错误密码 401', async () => {
    const res = await api('POST', '/api/auth/login', { name: 'alice', password: 'wrong' }, false)
    expect(res.status).toBe(401)
  })

  it('me 返回当前用户', async () => {
    const res = await api('GET', '/api/auth/me')
    expect(await res.json()).toEqual({ user: 'alice' })
  })
})

describe('文件树与 CRUD', () => {
  it('读取目录树', async () => {
    const res = await api('GET', '/api/files/tree')
    const { tree } = (await res.json()) as { tree: { path: string; type: string }[] }
    expect(tree.map((n) => n.path)).toEqual(['子目录', '首页.md'])
  })

  it('新建文件自动补 .md 后缀', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '新文档', type: 'file' })
    expect(res.status).toBe(201)
    const { path: p } = (await res.json()) as { path: string }
    expect(p).toBe('新文档.md')
    expect(fs.existsSync(path.join(process.env.NOTES_DIR!, p))).toBe(true)
  })

  it('新建文件夹', async () => {
    const res = await api('POST', '/api/files', { parentDir: '', name: '项目', type: 'folder' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { path: string }).path).toBe('项目')
  })

  it('读取文件内容', async () => {
    const res = await api('GET', '/api/files/content?path=' + encodeURIComponent('首页.md'))
    expect(res.status).toBe(200)
    const { content } = (await res.json()) as { content: string }
    expect(content).toContain('你好 MarkFlow')
  })

  it('重命名', async () => {
    const res = await api('POST', '/api/files/rename', { path: '首页.md', newName: '主页.md' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(process.env.NOTES_DIR!, '主页.md'))).toBe(true)
  })

  it('移动到子目录', async () => {
    const res = await api('POST', '/api/files/move', { path: '新文档.md', newParentDir: '子目录' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { path: string }).path).toBe('子目录/新文档.md')
    expect(fs.existsSync(path.join(process.env.NOTES_DIR!, '子目录/新文档.md'))).toBe(true)
  })

  it('禁止移动文件夹到自身内部', async () => {
    const res = await api('POST', '/api/files/move', { path: '子目录', newParentDir: '子目录' })
    expect(res.status).toBe(400)
  })

  it('删除文件', async () => {
    const res = await api('POST', '/api/files/delete', { path: '子目录/新文档.md' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(process.env.NOTES_DIR!, '子目录/新文档.md'))).toBe(false)
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
    expect(res.status).not.toBe(500)
  })

  it('穿越新建被拦截', async () => {
    const res = await api('POST', '/api/files', { parentDir: '../..', name: 'evil.md' })
    expect(res.status).toBe(400)
  })

  it('主题路径穿越被拦截', async () => {
    const res = await api('GET', '/api/themes/..%2F..%2Fetc%2Fpasswd.css')
    expect(res.status).toBe(400)
  })
})

describe('主题接口', () => {
  it('主题列表', async () => {
    const res = await api('GET', '/api/themes')
    const { themes } = (await res.json()) as { themes: { name: string }[] }
    expect(themes.map((t) => t.name)).toContain('demo')
  })

  it('下发 CSS', async () => {
    const res = await api('GET', '/api/themes/demo.css')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(await res.text()).toContain('color: red')
  })
})
