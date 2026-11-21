import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import type { IncomingHttpHeaders } from 'node:http'
import type { Response } from 'express'
import { config } from '../config.js'
import { parseCookies } from '../util/cookies.js'

const secretKey = new TextEncoder().encode(config.jwtSecret)

export const COOKIE_NAME = 'mf_token'
const TOKEN_TTL_SECONDS = 7 * 24 * 3600
/** WS 专用短寿命 token（provider 认证通道）：暴露面收敛到分钟级 */
export const WS_TOKEN_TTL_SECONDS = 60

/** 校验用户名密码（AUTH_USERS 支持 bcrypt 哈希与明文两种形态） */
export async function verifyUser(name: string, password: string): Promise<string | null> {
  const user = config.users.find((u) => u.name === name)
  if (!user || password === '') return null
  const ok = user.secret.startsWith('$2')
    ? await bcrypt.compare(password, user.secret)
    : user.secret === password
  return ok ? user.name : null
}

export async function issueToken(
  name: string,
  opts?: { ttlSeconds?: number; purpose?: string },
): Promise<string> {
  const builder = new SignJWT({ name, ...(opts?.purpose ? { purpose: opts.purpose } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(name)
    .setIssuedAt()
    .setExpirationTime(`${opts?.ttlSeconds ?? TOKEN_TTL_SECONDS}s`)
  return builder.sign(secretKey)
}

/** 校验 token，返回用户名；失败返回 null */
export async function verifyToken(token: string | undefined): Promise<string | null> {
  const payload = await verifyTokenPayload(token)
  return payload?.name ?? null
}

export interface TokenPayload {
  name: string
  /** 过期时刻（Unix 秒）——滑动续期判断用 */
  exp: number
  /** ws 短寿命 token 标记（正常登录 token 无此 claim） */
  purpose?: string
}

/** 校验 token 返回完整 payload（续期判断/ws-token 校验用）；失败返回 null */
export async function verifyTokenPayload(token: string | undefined): Promise<TokenPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey)
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null
    return {
      name: payload.sub,
      exp: payload.exp,
      purpose: typeof payload.purpose === 'string' ? payload.purpose : undefined,
    }
  } catch {
    return null
  }
}

/** 头里取原始 token（Cookie 优先级低于 Bearer） */
export function tokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization
  return auth?.startsWith('Bearer ') ? auth.slice(7) : parseCookies(headers.cookie)[COOKIE_NAME]
}

/** 从 HTTP 头（Cookie 或 Authorization Bearer）中提取并校验身份 */
export async function identityFromHeaders(headers: IncomingHttpHeaders): Promise<string | null> {
  return verifyToken(tokenFromHeaders(headers))
}

/** 登录态写入（login 与滑动续期共用） */
export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_TTL_SECONDS * 1000,
  })
}

/**
 * 滑动续期：正常登录 token 剩余寿命不足一半时重签 cookie——页面开着
 * （30 分钟一次 /me 保活 + 每次 WS 连接取 ws-token）就不过期。
 * ws 短寿命 token 不参与续期（它不是会话凭证）。
 */
export async function renewAuthCookie(headers: IncomingHttpHeaders, res: Response): Promise<void> {
  const payload = await verifyTokenPayload(tokenFromHeaders(headers))
  if (!payload || payload.purpose) return
  if (payload.exp - Math.floor(Date.now() / 1000) < TOKEN_TTL_SECONDS / 2) {
    setAuthCookie(res, await issueToken(payload.name))
  }
}

export { TOKEN_TTL_SECONDS }
