import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { config } from '../config.js'
import { PathError } from '../files/paths.js'

export const themesRouter = Router()

/** 允许中文等非 ASCII 主题文件名，但拒绝路径分隔符与特殊字符 */
const CSS_NAME_RE = /^[\w\u00c0-\uffff][\w .\-\u00c0-\uffff]*\.css$/i

/** GET /api/themes — 可用主题列表 */
themesRouter.get('/themes', (_req, res) => {
  fs.mkdirSync(config.themesDir, { recursive: true })
  const names = fs
    .readdirSync(config.themesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.css'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  res.json({
    themes: names.map((file) => ({
      name: file.replace(/\.css$/i, ''),
      file,
      url: `/api/themes/${encodeURIComponent(file)}`,
    })),
  })
})

/** GET /api/themes/:file — 下发主题 CSS（严格白名单文件名，无路径分隔符） */
themesRouter.get('/themes/:file', (req, res) => {
  const file = String(req.params.file)
  if (!CSS_NAME_RE.test(file)) throw new PathError('非法主题文件名')
  const abs = path.resolve(config.themesDir, file)
  const themesReal = fs.realpathSync(config.themesDir)
  if (fs.existsSync(abs) && fs.realpathSync(abs).startsWith(themesReal + path.sep)) {
    res.type('text/css').sendFile(abs)
    return
  }
  throw new PathError('主题不存在', 404)
})
