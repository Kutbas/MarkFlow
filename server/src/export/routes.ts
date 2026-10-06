import { Router } from 'express'
import { COOKIE_NAME } from '../auth/service.js'
import { parseCookies } from '../util/cookies.js'
import { renderPdf } from './pdf.js'

export const exportRouter = Router()

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
