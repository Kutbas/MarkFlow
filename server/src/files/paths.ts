import fs from 'node:fs'
import path from 'node:path'

/** 业务路径错误（携带 HTTP 状态码） */
export class PathError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'PathError'
  }
}

export function isMarkdownPath(p: string): boolean {
  return /\.md$/i.test(p)
}

/** 规范化相对路径：反斜杠→正斜杠、去空段与 "." 段，保留 ".." 供上层显式拒绝 */
function normalizeRel(rel: string): string {
  return rel
    .replaceAll('\\', '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/')
}

/**
 * 纯语法路径校验（无磁盘依赖；PG 存储模式使用）。
 * 防护：null byte、绝对路径、`..` 穿越；可选强制 .md。
 * 返回规范化相对路径（POSIX 分隔符）。
 */
export function validateRelPath(
  relPath: string,
  opts: { mustBeMd?: boolean } = {},
): string {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new PathError('路径包含非法字符')
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new PathError('必须提供相对路径')
  }
  const rel = normalizeRel(relPath)
  if (rel === '') throw new PathError('路径为空')
  if (rel.split('/').includes('..')) throw new PathError('路径不允许包含 ..')
  if (opts.mustBeMd && !isMarkdownPath(rel)) {
    throw new PathError('仅允许操作 .md 文件')
  }
  return rel
}

/**
 * 深度前缀的 symlink 逃逸检查：
 * 从 target 向上找到最近的存在路径，realpath 后必须仍在 base 的真实路径内。
 */
function assertNoSymlinkEscape(base: string, target: string): void {
  const baseReal = fs.realpathSync(base)
  let probe = target
  while (!fs.existsSync(probe)) probe = path.dirname(probe)
  const probeReal = fs.realpathSync(probe)
  if (probeReal !== baseReal && !probeReal.startsWith(baseReal + path.sep)) {
    throw new PathError('路径越界（symlink 逃逸）')
  }
}

export interface SafeJoinOptions {
  /** 文件必须已存在 */
  mustExist?: boolean
  /** 必须是 .md 文件 */
  mustBeMd?: boolean
}

/**
 * 磁盘模式的路径安全入口：语法校验 + 前缀约束 + symlink 逃逸检查。
 * 返回绝对路径与规范化相对路径。
 */
export function safeJoin(
  baseDir: string,
  relPath: string,
  opts: SafeJoinOptions = {},
): { abs: string; rel: string } {
  const rel = validateRelPath(relPath, { mustBeMd: opts.mustBeMd })

  const base = path.resolve(baseDir)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new PathError('路径越界')
  }
  assertNoSymlinkEscape(base, abs)
  if (opts.mustExist && !fs.existsSync(abs)) {
    throw new PathError('路径不存在', 404)
  }
  return { abs, rel }
}

/** 校验单个文件/文件夹名（用于创建与重命名） */
export function validateName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new PathError('名称为空')
  if (name.length > 200) throw new PathError('名称过长')
  if (name.startsWith('.')) throw new PathError('名称不能以点开头')
  if ((/[\\/:*?"<>|\0]/ as RegExp).test(name)) throw new PathError('名称包含非法字符 /\\:*?"<>|')
  return name
}
