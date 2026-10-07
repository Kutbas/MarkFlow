/**
 * 纯单元覆盖：config / bootstrap / cookies / atomicWrite / docRegistry / auth service。
 * config 与 bootstrap 在模块加载期读 env，因此用 resetModules + 动态 import 隔离。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-unit-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('config 环境解析', () => {
  it('默认值兜底（PORT 非法、缺省 HOST 等）', async () => {
    vi.stubEnv('PORT', 'not-a-number')
    vi.stubEnv('HOST', '')
    const { config } = await import('../src/config.js')
    expect(config.port).toBe(8080)
    expect(config.host).toBe('')
    expect(config.flushDebounce.waitMs).toBe(1500)
    expect(config.flushDebounce.maxWaitMs).toBe(5000)
  })

  it('AUTH_USERS 为空时拒绝启动', async () => {
    vi.stubEnv('AUTH_USERS', '')
    await expect(import('../src/config.js')).rejects.toThrow('AUTH_USERS')
  })

  it('AUTH_USERS 条目缺冒号时报错', async () => {
    vi.stubEnv('AUTH_USERS', 'alice')
    await expect(import('../src/config.js')).rejects.toThrow('格式错误')
  })

  it('正常解析多用户', async () => {
    vi.stubEnv('AUTH_USERS', 'alice:pass1,bob:$2a$10$hash')
    const { config } = await import('../src/config.js')
    expect(config.users).toEqual([
      { name: 'alice', secret: 'pass1' },
      { name: 'bob', secret: '$2a$10$hash' },
    ])
  })
})

describe('parseCookies', () => {
  it('常规/畸形/编码值', async () => {
    const { parseCookies } = await import('../src/util/cookies.js')
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' })
    expect(parseCookies('broken-key-no-eq; c=3;;  =x')).toEqual({ c: '3' })
    expect(parseCookies('zh=%E4%B8%AD')).toEqual({ zh: '中' })
    expect(parseCookies(undefined)).toEqual({})
  })
})

describe('atomicWrite 与 sha1', () => {
  it('原子写盘不留临时文件', async () => {
    const { atomicWrite, sha1 } = await import('../src/util/atomicWrite.js')
    const target = path.join(tmp, 'f.md')
    await atomicWrite(target, '内容一')
    expect(fs.readFileSync(target, 'utf8')).toBe('内容一')
    await atomicWrite(target, '内容二')
    expect(fs.readFileSync(target, 'utf8')).toBe('内容二')
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('.tmp-'))).toEqual([])
    expect(sha1('abc')).toHaveLength(40)
    expect(sha1('abc')).toBe(sha1('abc'))
    expect(sha1('abc')).not.toBe(sha1('abd'))
  })
})

describe('docRegistry', () => {
  it('docName 与相对路径互转 + 哈希记录', async () => {
    fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true })
    vi.stubEnv('NOTES_DIR', path.join(tmp, 'notes'))
    const reg = await import('../src/collab/docRegistry.js')
    expect(reg.relToDocName('目录/文档.md')).toBe('目录/文档.md')
    expect(reg.docNameToRel('目录/文档.md')).toBe('目录/文档.md')
    // 非法文档名（含 ..）被拒绝
    expect(() => reg.docNameToRel('../escape.md')).toThrow()
    expect(() => reg.docNameToRel('%ZZ-bad')).toThrow('非法文档名')

    reg.ensureState('a.md')
    expect(reg.getLastKnownHash('a.md')).toBeNull()
    fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'notes', 'a.md'), '# a')
    reg.setLastKnownHash('a.md', 'x')
    expect(reg.getLastKnownHash('a.md')).toBe('x')
    reg.forgetState('a.md')
    expect(reg.getLastKnownHash('a.md')).toBeNull()
    // 未 ensure 的路径 setLastKnownHash 不生效（防错写）
    reg.setLastKnownHash('never.md', 'y')
    expect(reg.getLastKnownHash('never.md')).toBeNull()
  })
})

describe('auth service 扩展分支', () => {
  it('bcrypt 哈希用户可登录、明文错误被拒', async () => {
    const bcrypt = await import('bcryptjs')
    const hash = bcrypt.hashSync('s3cret', 4)
    vi.stubEnv('AUTH_USERS', `carol:${hash}`)
    vi.stubEnv('JWT_SECRET', 'unit-test-secret')
    const { verifyUser, issueToken, verifyToken } = await import('../src/auth/service.js')
    expect(await verifyUser('carol', 's3cret')).toBe('carol')
    expect(await verifyUser('carol', 'wrong')).toBeNull()
    expect(await verifyUser('nobody', 's3cret')).toBeNull()
    expect(await verifyUser('carol', '')).toBeNull()

    const token = await issueToken('carol')
    expect(await verifyToken(token)).toBe('carol')
    expect(await verifyToken(undefined)).toBeNull()
    expect(await verifyToken('garbage.token.here')).toBeNull()
  })

  it('Bearer 头与 Cookie 两种身份来源', async () => {
    vi.stubEnv('AUTH_USERS', 'dave:pw')
    vi.stubEnv('JWT_SECRET', 'unit-test-secret')
    const { identityFromHeaders, issueToken } = await import('../src/auth/service.js')
    const token = await issueToken('dave')
    expect(await identityFromHeaders({ authorization: `Bearer ${token}` })).toBe('dave')
    expect(await identityFromHeaders({ cookie: `other=1; mf_token=${token}` })).toBe('dave')
    expect(await identityFromHeaders({ cookie: 'mf_token=bad' })).toBeNull()
    expect(await identityFromHeaders({})).toBeNull()
  })
})

describe('validateName 边界', () => {
  it('超长名称被拒', async () => {
    const { validateName } = await import('../src/files/paths.js')
    expect(() => validateName('x'.repeat(201))).toThrow('名称过长')
    expect(validateName('正常名')).toBe('正常名')
  })
})

describe('interop Yjs 直写（覆盖非编辑器路径）', () => {
  it('空 Y.Doc 序列化为空文档', async () => {
    const { yDocToMd } = await import('../src/interop/index.js')
    const empty = new Y.Doc()
    expect(await yDocToMd(empty)).toBe('')
  })
})
