import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathError, safeJoin, validateName } from '../src/files/paths.js'

let base: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-paths-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('safeJoin 攻击向量', () => {
  it('放行正常相对路径', () => {
    expect(safeJoin(base, '笔记.md').rel).toBe('笔记.md')
    expect(safeJoin(base, '目录/子目录/文档.md').rel).toBe('目录/子目录/文档.md')
    expect(safeJoin(base, './a//b/c.md').rel).toBe('a/b/c.md')
  })

  it('拒绝 .. 穿越', () => {
    expect(() => safeJoin(base, '../escape.md')).toThrow(PathError)
    expect(() => safeJoin(base, 'a/../../escape.md')).toThrow(PathError)
    expect(() => safeJoin(base, '..')).toThrow(PathError)
    expect(() => safeJoin(base, 'a/b/../../../etc/passwd')).toThrow(PathError)
  })

  it('拒绝绝对路径（POSIX / Windows 盘符）', () => {
    expect(() => safeJoin(base, '/etc/passwd')).toThrow(PathError)
    expect(() => safeJoin(base, 'C:/Windows/system32')).toThrow(PathError)
  })

  it('拒绝 null byte 与空串', () => {
    expect(() => safeJoin(base, 'a\0b.md')).toThrow(PathError)
    expect(() => safeJoin(base, '')).toThrow(PathError)
    expect(() => safeJoin(base, '.')).toThrow(PathError)
  })

  it('拒绝反斜杠形态的穿越', () => {
    expect(() => safeJoin(base, '..\\..\\escape.md')).toThrow(PathError)
  })

  it('拒绝 symlink 逃逸', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-outside-'))
    const secretFile = path.join(outside, 'secret.md')
    fs.writeFileSync(secretFile, '秘密')
    const link = path.join(base, '链接.md')
    fs.symlinkSync(secretFile, link)
    expect(() => safeJoin(base, '链接.md', { mustExist: true })).toThrow(PathError)

    // 目录形式的 symlink 逃逸
    const linkDir = path.join(base, '链接目录')
    fs.symlinkSync(outside, linkDir)
    expect(() => safeJoin(base, '链接目录/secret.md', { mustExist: true })).toThrow(PathError)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('mustExist / mustBeMd 选项', () => {
    expect(() => safeJoin(base, '不存在.md', { mustExist: true })).toThrow(PathError)
    expect(() => safeJoin(base, 'a.md', { mustBeMd: true })).not.toThrow()
    expect(() => safeJoin(base, 'a.txt', { mustBeMd: true })).toThrow(PathError)
  })
})

describe('validateName', () => {
  it('放行中文与常见符号', () => {
    expect(validateName('会议记录 10-06')).toBe('会议记录 10-06')
    expect(validateName('a-b_c.d')).toBe('a-b_c.d')
  })
  it('拒绝非法名称', () => {
    expect(() => validateName('')).toThrow(PathError)
    expect(() => validateName('.隐藏')).toThrow(PathError)
    expect(() => validateName('a/b')).toThrow(PathError)
    expect(() => validateName('a\\b')).toThrow(PathError)
    expect(() => validateName('a:b')).toThrow(PathError)
    expect(() => validateName('x'.repeat(201))).toThrow(PathError)
  })
})
