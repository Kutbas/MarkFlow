import { describe, expect, it } from 'vitest'
import { PathError, validateName, validateRelPath } from '../src/files/paths.js'

describe('validateRelPath 攻击向量', () => {
  it('放行正常相对路径并规范化', () => {
    expect(validateRelPath('笔记.md')).toBe('笔记.md')
    expect(validateRelPath('目录/子目录/文档.md')).toBe('目录/子目录/文档.md')
    expect(validateRelPath('./a//b/c.md')).toBe('a/b/c.md')
  })

  it('拒绝 .. 穿越', () => {
    expect(() => validateRelPath('../escape.md')).toThrow(PathError)
    expect(() => validateRelPath('a/../../escape.md')).toThrow(PathError)
    expect(() => validateRelPath('a/b/../../../etc/passwd', { mustBeMd: true })).toThrow(PathError)
  })

  it('拒绝绝对路径（POSIX / Windows 盘符）', () => {
    expect(() => validateRelPath('/etc/passwd')).toThrow(PathError)
    expect(() => validateRelPath('C:/Windows/system32')).toThrow(PathError)
  })

  it('拒绝 null byte 与空串', () => {
    expect(() => validateRelPath('a\0b.md')).toThrow(PathError)
    expect(() => validateRelPath('')).toThrow(PathError)
    expect(() => validateRelPath('.')).toThrow(PathError)
  })

  it('拒绝反斜杠形态的穿越', () => {
    expect(() => validateRelPath('..\\..\\escape.md')).toThrow(PathError)
  })

  it('mustBeMd 选项', () => {
    expect(() => validateRelPath('a.txt', { mustBeMd: true })).toThrow(PathError)
    expect(() => validateRelPath('目录', { mustBeMd: true })).toThrow(PathError)
    expect(validateRelPath('a.md', { mustBeMd: true })).toBe('a.md')
    expect(validateRelPath('目录', { mustBeMd: false })).toBe('目录')
  })
})

describe('validateName', () => {
  it('放行中文与常见符号', () => {
    expect(validateName('会议记录 10-06')).toBe('会议记录 10-06')
    expect(validateName('a-b_c.d')).toBe('a-b_c.d')
  })
  it('拒绝非法名称', () => {
    for (const bad of ['', '.隐藏', 'a/b', 'a\\b', 'a:b', 'x'.repeat(201)]) {
      expect(() => validateName(bad)).toThrow(PathError)
    }
  })
})
