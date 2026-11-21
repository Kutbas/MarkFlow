import { Router } from 'express'
import {
  COOKIE_NAME,
  WS_TOKEN_TTL_SECONDS,
  identityFromHeaders,
  issueToken,
  renewAuthCookie,
  setAuthCookie,
  verifyUser,
} from './service.js'
import { requireAuth } from './middleware.js'

export const authRouter = Router()

authRouter.post('/login', async (req, res) => {
  const { name, password } = req.body as { name?: string; password?: string }
  if (typeof name !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: '请提供用户名和密码' })
    return
  }
  const userName = await verifyUser(name, password)
  if (!userName) {
    res.status(401).json({ error: '用户名或密码错误' })
    return
  }
  setAuthCookie(res, await issueToken(userName))
  res.json({ user: userName })
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' })
  res.json({ ok: true })
})

authRouter.get('/me', async (req, res) => {
  const user = await identityFromHeaders(req.headers)
  // 登录态下顺手滑动续期（客户端 30 分钟保活 ping 即走这里）
  if (user) await renewAuthCookie(req.headers, res)
  res.json({ user })
})

/** WS 认证通道：provider 的 token 回调取短寿命 JWT（httpOnly cookie 前端
 *  拿不到）——hocuspocus onAuthenticate 校验，前端可区分"未认证 vs 断线" */
authRouter.get('/ws-token', requireAuth, async (req, res) => {
  const user = res.locals.user as string
  const token = await issueToken(user, { ttlSeconds: WS_TOKEN_TTL_SECONDS, purpose: 'ws' })
  res.json({ token })
})
