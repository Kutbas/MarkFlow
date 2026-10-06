/**
 * PDF 导出路由分支（renderPdf 以 mock 替换，真实渲染冒烟见 export-smoke）。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.WEB_DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/webdist',
)

const pdfMock = vi.hoisted(() => ({
  renderPdf: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x66, 0x69, 0x78])),
}))
vi.mock('../src/export/pdf.js', () => pdfMock)

const { createApp } = await import('../src/app.js')
const { issueToken } = await import('../src/auth/service.js')

let server: http.Server
let base: string
let cookie = ''
const NOTES = process.env.NOTES_DIR!

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const token = await issueToken('alice')
  cookie = `mf_token=${token}`
})

afterAll(async () => {
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
  vi.clearAllMocks()
})

function post(body: unknown, useCookie = true): Promise<Response> {
  return fetch(`${base}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(useCookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
}

describe('导出路由', () => {
  it('缺少 path → 400', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ path: 123 })).status).toBe(400)
  })

  it('未登录 → 401', async () => {
    expect((await post({ path: 'a.md' }, false)).status).toBe(401)
  })

  it('渲染成功 → application/pdf + 中文文件名附件头', async () => {
    fs.writeFileSync(path.join(NOTES, '导出测试.md'), '# E\n')
    const res = await post({ path: '导出测试.md', theme: 'markflow-paper' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('导出测试.pdf')}`,
    )
    const buf = new Uint8Array(await res.arrayBuffer())
    // %PDF- magic
    expect(buf[0]).toBe(0x25)
    expect(String.fromCharCode(...buf.slice(0, 4))).toBe('%PDF')
    expect(pdfMock.renderPdf).toHaveBeenCalledWith('导出测试.md', 'markflow-paper', cookie.split('=')[1])
  })

  it('渲染抛错 → 500', async () => {
    pdfMock.renderPdf.mockRejectedValueOnce(new Error('chromium 崩溃'))
    const res = await post({ path: '导出测试.md' })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toContain('导出失败')
  })

  it('WEB_DIST 存在时静态托管前端（SPA 回退）', async () => {
    const index = await fetch(`${base}/`)
    expect(index.status).toBe(200)
    const spa = await fetch(`${base}/some/route`)
    expect(spa.status).toBe(200)
  })
})
