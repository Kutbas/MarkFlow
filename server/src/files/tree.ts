import fs from 'node:fs'
import path from 'node:path'
import { isMarkdownPath } from './paths.js'

export interface TreeNode {
  name: string
  /** POSIX 风格相对路径（相对笔记根目录） */
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

/** 递归读取目录树：仅显示目录与 .md 文件，隐藏点开头条目（.git/.DS_Store 等） */
export function readTree(rootDir: string, relDir = ''): TreeNode[] {
  const absDir = relDir ? path.join(rootDir, relDir) : rootDir
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, type: 'dir', children: readTree(rootDir, rel) })
    } else if (entry.isFile() && isMarkdownPath(entry.name)) {
      nodes.push({ name: entry.name, path: rel, type: 'file' })
    }
  }
  const zh = new Intl.Collator('zh-Hans-CN', { numeric: true })
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return zh.compare(a.name, b.name)
  })
  return nodes
}
