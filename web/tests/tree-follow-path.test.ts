/** followMovedPath：路径迁移后重写当前打开文档的路径（A/B 端共用） */
import { describe, expect, it } from 'vitest'
import { followMovedPath } from '../src/components/FileTree'

describe('followMovedPath', () => {
  it('打开的正是被移动的文档 → 换成新路径', () => {
    expect(followMovedPath('笔记.md', '笔记.md', '目录/笔记.md')).toBe('目录/笔记.md')
  })

  it('打开的是被移动文件夹的子孙 → 前缀整体跟随', () => {
    expect(followMovedPath('a/b/深处的文档.md', 'a', 'x/y')).toBe('x/y/b/深处的文档.md')
  })

  it('重命名打开的文件夹 → 子孙路径跟随新名', () => {
    expect(followMovedPath('开始/手册.md', '开始', '起步')).toBe('起步/手册.md')
  })

  it('无关路径不受影响', () => {
    expect(followMovedPath('其他文档.md', '笔记.md', '目录/笔记.md')).toBe('其他文档.md')
    // 前缀相似但非目录边界（"笔记 2.md" 不在 "笔记.md" 之内）
    expect(followMovedPath('笔记 2.md', '笔记.md', '目录/笔记.md')).toBe('笔记 2.md')
  })

  it('未打开文档时返回 null', () => {
    expect(followMovedPath(null, '笔记.md', '目录/笔记.md')).toBeNull()
    expect(followMovedPath(undefined, '笔记.md', '目录/笔记.md')).toBeNull()
  })
})
