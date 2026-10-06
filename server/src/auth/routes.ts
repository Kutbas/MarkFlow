import { Router } from 'express'
import { COOKIE_NAME, TOKEN_TTL_SECONDS, identityFromHeaders, issueToken, verifyUser } from './service.js'

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
  const token = await issueToken(userName)
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS * 1000,
  })
  res.json({ user: userName })
})

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' })
  res.json({ ok: true })
})

authRouter.get('/me', async (req, res) => {
  const user = await identityFromHeaders(req.headers)
  res.json({ user })
})
