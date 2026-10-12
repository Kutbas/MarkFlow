/** 侧栏搜索的纯逻辑（文档树/大纲匹配），独立导出便于单测 */
import type { TreeNode } from '../api/client'
import type { OutlineItem } from './Outline'

/** 文档树搜索：按名称（含完整路径）不分大小写匹配，文档序返回 */
export function searchTree(tree: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: TreeNode[] = []
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return out
}

/** 大纲搜索：标题文本不分大小写匹配，文档序返回 */
export function searchOutline(outline: OutlineItem[], query: string): OutlineItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return outline.filter((o) => o.text.toLowerCase().includes(q))
}

/** 循环步进（Chrome 搜索手感：到底回绕） */
export function stepMatch(index: number, dir: 1 | -1, total: number): number {
  if (total <= 0) return 0
  return (index + dir + total) % total
}
