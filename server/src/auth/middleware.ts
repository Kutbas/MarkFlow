import type { NextFunction, Request, Response } from 'express'
import { identityFromHeaders, renewAuthCookie } from './service.js'

/** /api 路由统一鉴权守卫：通过后 res.locals.user 为用户名；
 *  顺手做滑动续期（token 剩余寿命过半即重签 cookie，开着页面不过期） */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await identityFromHeaders(req.headers)
  if (!user) {
    res.status(401).json({ error: '未登录' })
    return
  }
  res.locals.user = user
  await renewAuthCookie(req.headers, res)
  next()
}
