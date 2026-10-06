import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import type { IncomingHttpHeaders } from 'node:http'
import { config } from '../config.js'
import { parseCookies } from '../util/cookies.js'

const secretKey = new TextEncoder().encode(config.jwtSecret)

export const COOKIE_NAME = 'mf_token'
const TOKEN_TTL_SECONDS = 7 * 24 * 3600

/** 校验用户名密码（AUTH_USERS 支持 bcrypt 哈希与明文两种形态） */
export async function verifyUser(name: string, password: string): Promise<string | null> {
  const user = config.users.find((u) => u.name === name)
  if (!user || password === '') return null
  const ok = user.secret.startsWith('$2')
    ? await bcrypt.compare(password, user.secret)
    : user.secret === password
  return ok ? user.name : null
}

export async function issueToken(name: string): Promise<string> {
  return new SignJWT({ name })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(name)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secretKey)
}

/** 校验 token，返回用户名；失败返回 null */
export async function verifyToken(token: string | undefined): Promise<string | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secretKey)
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** 从 HTTP 头（Cookie 或 Authorization Bearer）中提取并校验身份 */
export async function identityFromHeaders(headers: IncomingHttpHeaders): Promise<string | null> {
  const auth = headers.authorization
  const token =
    auth?.startsWith('Bearer ') ? auth.slice(7) : parseCookies(headers.cookie)[COOKIE_NAME]
  return verifyToken(token)
}

export { TOKEN_TTL_SECONDS }
