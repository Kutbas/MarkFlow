/**
 * PDF 真实渲染冒烟：Puppeteer + fixture 导出页（真实 Chromium，无 mock）。
 */
import './helpers/env.js'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

process.env.WEB_DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/webdist',
)

const { createApp } = await import('../src/app.js')
const { issueToken } = await import('../src/auth/service.js')
const { renderPdf } = await import('../src/export/pdf.js')

let server: http.Server
let base: string
const NOTES = process.env.NOTES_DIR!

beforeAll(async () => {
  server = http.createServer(createApp())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  base = `http://127.0.0.1:${port}`
  // renderPdf 的导出页来源：指向本测试服务器（默认会打到 8080）
  process.env.EXPORT_ORIGIN = base
})

afterAll(async () => {
  delete process.env.EXPORT_ORIGIN
  server.closeAllConnections?.()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('renderPdf 真实冒烟', () => {
  it('渲染出合法 PDF（Chromium 真实启动 + cookie 鉴权 + 等待就绪）', async () => {
    fs.writeFileSync(path.join(NOTES, '冒烟导出.md'), '# 冒烟\n')
    const token = await issueToken('alice')
    const pdf = await renderPdf('冒烟导出.md', 'markflow-paper', token)
    expect(pdf.byteLength).toBeGreaterThan(1000)
    expect(String.fromCharCode(...pdf.slice(0, 4))).toBe('%PDF')
  }, 60_000)

  it('不存在的文件 → PathError 404 / 路径穿越被拦', async () => {
    const token = await issueToken('alice')
    await expect(renderPdf('不存在.md', undefined, token)).rejects.toThrow('不存在')
    await expect(renderPdf('../../etc/passwd', undefined, token)).rejects.toThrow('路径')
  })
})
