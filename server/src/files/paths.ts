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

/** 规范化相对路径：反斜杠→正斜杠、去空段与 "." 段 */
function normalizeRel(rel: string): string {
  return rel
    .replaceAll('\\', '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/')
}

/**
 * 全站唯一的路径安全入口（纯语法，无磁盘依赖）。
 * 防护：null byte、绝对路径（POSIX/Windows 盘符）、`..` 穿越；可选强制 .md。
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

/** 校验单个文件/文件夹名（用于创建与重命名） */
export function validateName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) throw new PathError('名称为空')
  if (name.length > 200) throw new PathError('名称过长')
  if (name.startsWith('.')) throw new PathError('名称不能以点开头')
  if ((/[\\/:*?"<>|\0]/ as RegExp).test(name)) throw new PathError('名称包含非法字符 /\\:*?"<>|')
  return name
}

void path
