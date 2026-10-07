import { Router } from 'express'
import { COOKIE_NAME } from '../auth/service.js'
import { parseCookies } from '../util/cookies.js'
import { renderPdf } from './pdf.js'

export const exportRouter = Router()

/** GET /api/export/md?path= — 下载单篇 Markdown（数据库模式的"导出即文件"） */
exportRouter.get('/export/md', async (req, res) => {
  const rel = String(req.query.path ?? '')
  if (!rel) {
    res.status(400).json({ error: '缺少 path' })
    return
  }
  const { validateRelPath } = await import('../files/paths.js')
  let clean: string
  try {
    clean = validateRelPath(rel, { mustBeMd: true })
  } catch {
    res.status(400).json({ error: '非法路径' })
    return
  }
  const { getStorage } = await import('../storage/index.js')
  try {
    const md = await (await getStorage()).readMarkdown(clean)
    const filename = `${clean.split('/').pop()?.replace(/\.md$/i, '') ?? 'export'}.md`
    res
      .type('text/markdown; charset=utf-8')
      .set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(md)
  } catch {
    res.status(404).json({ error: '文档不存在' })
  }
})

/** POST /api/export/pdf { path, theme? } → 高保真 PDF（Puppeteer 后台渲染） */
exportRouter.post('/export/pdf', async (req, res) => {
  const { path: rel, theme } = req.body as { path?: string; theme?: string }
  if (typeof rel !== 'string' || rel === '') {
    res.status(400).json({ error: '缺少 path' })
    return
  }
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
  if (!token) {
    res.status(401).json({ error: '未登录' })
    return
  }
  try {
    const pdf = await renderPdf(rel, theme, token)
    const filename = `${rel.split('/').pop()?.replace(/\.md$/i, '') ?? 'export'}.pdf`
    res
      .type('application/pdf')
      .set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(Buffer.from(pdf))
  } catch (err) {
    console.error('[MarkFlow] PDF 导出失败:', err)
    res.status(500).json({ error: 'PDF 导出失败' })
  }
})
