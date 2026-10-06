import fs from 'node:fs'
import express, { type ErrorRequestHandler } from 'express'
import { config } from './config.js'
import { authRouter } from './auth/routes.js'
import { requireAuth } from './auth/middleware.js'
import { filesRouter } from './files/routes.js'
import { themesRouter } from './themes/routes.js'
import { exportRouter } from './export/routes.js'
import { PathError } from './files/paths.js'
import { sseHub } from './events.js'

export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'MarkFlow', time: new Date().toISOString() })
  })

  // 登录相关无需鉴权
  app.use('/api/auth', authRouter)

  // SSE 事件流（需登录）
  app.get('/api/events', requireAuth, (req, res) => {
    sseHub.subscribe(res)
  })

  // 业务 API（需登录）
  app.use('/api', requireAuth, filesRouter, themesRouter, exportRouter)

  // 生产模式：托管前端构建产物（带 SPA 回退）
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist))
    app.get(/^\/(?!api|collab).*/, (_req, res) => {
      res.sendFile(`${config.webDist}/index.html`)
    })
  }

  app.use((_, res) => {
    res.status(404).json({ error: '接口不存在' })
  })

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof PathError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    console.error('[MarkFlow] 未处理错误:', err)
    res.status(500).json({ error: '服务器内部错误' })
  }
  app.use(errorHandler)

  return app
}
