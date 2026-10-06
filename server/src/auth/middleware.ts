import type { NextFunction, Request, Response } from 'express'
import { identityFromHeaders } from './service.js'

/** /api 路由统一鉴权守卫：通过后 res.locals.user 为用户名 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await identityFromHeaders(req.headers)
  if (!user) {
    res.status(401).json({ error: '未登录' })
    return
  }
  res.locals.user = user
  next()
}
