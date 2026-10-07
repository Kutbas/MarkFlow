import { PathError, validateRelPath } from '../files/paths.js'

/** 协同文档的磁盘状态跟踪：用于落盘回声抑制与外部改动检测 */
interface DocState {
  /** 最近一次已知磁盘内容哈希（加载时、自身落盘时、外部重置时更新） */
  lastKnownDiskHash: string | null
}

const states = new Map<string, DocState>()

/**
 * 相对路径即 WebSocket 文档名（v4 协议 var-string 原生支持 UTF-8，无需编码）。
 * hocuspocus.documents 的键 = 原始相对路径。
 */
export function relToDocName(relPath: string): string {
  return relPath
}

/** 文档名 → 相对路径；非法文档名直接抛错拒绝连接 */
export function docNameToRel(documentName: string): string {
  let rel: string
  try {
    rel = decodeURIComponent(documentName)
  } catch {
    throw new PathError('非法文档名')
  }
  return validateRelPath(rel, { mustBeMd: true })
}

export function getLastKnownHash(relPath: string): string | null {
  return states.get(relPath)?.lastKnownDiskHash ?? null
}

export function setLastKnownHash(relPath: string, hash: string | null): void {
  const s = states.get(relPath)
  if (s) s.lastKnownDiskHash = hash
}

export function ensureState(relPath: string): void {
  if (!states.has(relPath)) states.set(relPath, { lastKnownDiskHash: null })
}

export function forgetState(relPath: string): void {
  states.delete(relPath)
}
