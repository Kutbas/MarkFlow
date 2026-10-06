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
 * 全站唯一的路径安全入口：把前端提交的相对路径限制在 baseDir 内。
 * 防护：null byte、绝对路径、`..` 穿越、symlink 逃逸。
 * 返回绝对路径；同时导出规范化后的相对路径（POSIX 分隔符）。
 */
export function safeJoin(
  baseDir: string,
  relPath: string,
  opts: SafeJoinOptions = {},
): { abs: string; rel: string } {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    throw new PathError('路径包含非法字符')
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new PathError('必须提供相对路径')
  }
  const rel = normalizeRel(relPath)
  if (rel === '') throw new PathError('路径为空')
  const segments = rel.split('/')
  if (segments.includes('..')) throw new PathError('路径不允许包含 ..')

  const base = path.resolve(baseDir)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new PathError('路径越界')
  }
  if (opts.mustBeMd && !isMarkdownPath(abs)) {
    throw new PathError('仅允许操作 .md 文件')
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
  if (/[\\/:*?"<>|\0]/.test(name)) throw new PathError('名称包含非法字符 /\\:*?"<>|')
  return name
}

/**
 * 「父目录」语义的拼接：空字符串表示根目录。
 * 仅用于 create/move 的父目录参数；delete/rename 等必须走 safeJoin（禁止空路径）。
 */
export function safeJoinDir(baseDir: string, relPath: string): { abs: string; rel: string } {
  if (relPath === '' || relPath === '.') {
    const base = path.resolve(baseDir)
    if (!fs.existsSync(base)) throw new PathError('根目录不存在', 404)
    return { abs: base, rel: '' }
  }
  return safeJoin(baseDir, relPath, { mustExist: true })
}
