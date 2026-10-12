/** 侧栏搜索纯逻辑：树/大纲匹配与循环步进 */
import { describe, expect, it } from 'vitest'
import { searchOutline, searchTree, stepMatch } from '../src/components/sidebar-search'
import type { TreeNode } from '../src/api/client'
import type { OutlineItem } from '../src/components/Outline'

describe('searchTree', () => {
  const tree: TreeNode[] = [
    { name: '嵌入式笔记.md', path: '嵌入式笔记.md', type: 'file' },
    {
      name: '开始',
      path: '开始',
      type: 'dir',
      children: [
        { name: '欢迎使用 MarkFlow.md', path: '开始/欢迎使用 MarkFlow.md', type: 'file' },
        { name: '快捷键手册.md', path: '开始/快捷键手册.md', type: 'file' },
      ],
    },
  ]

  it('按名称匹配文件与目录（文档序）', () => {
    expect(searchTree(tree, '笔记').map((n) => n.path)).toEqual(['嵌入式笔记.md'])
    expect(searchTree(tree, '手册').map((n) => n.path)).toEqual(['开始/快捷键手册.md'])
    // 目录名命中也带出其子文档（路径前缀匹配）
    expect(searchTree(tree, '开始').map((n) => n.path)).toEqual([
      '开始',
      '开始/欢迎使用 MarkFlow.md',
      '开始/快捷键手册.md',
    ])
  })

  it('大小写不敏感；完整路径也能匹配', () => {
    expect(searchTree(tree, 'markflow').map((n) => n.path)).toEqual([
      '开始/欢迎使用 MarkFlow.md',
    ])
  })

  it('空查询返回空', () => {
    expect(searchTree(tree, '')).toEqual([])
    expect(searchTree(tree, '   ')).toEqual([])
  })
})

describe('searchOutline', () => {
  const outline: OutlineItem[] = [
    { level: 1, text: '嵌入式历史与生态', index: 0 },
    { level: 2, text: 'GPIO 基础', index: 1 },
    { level: 2, text: 'GPIO 进阶', index: 2 },
    { level: 1, text: '结语', index: 3 },
  ]

  it('标题文本匹配（文档序）', () => {
    expect(searchOutline(outline, 'gpio').map((o) => o.index)).toEqual([1, 2])
    expect(searchOutline(outline, '结语').map((o) => o.index)).toEqual([3])
  })

  it('空查询返回空', () => {
    expect(searchOutline(outline, '')).toEqual([])
  })
})

describe('stepMatch 循环步进', () => {
  it('前进/后退/回绕', () => {
    expect(stepMatch(0, 1, 5)).toBe(1)
    expect(stepMatch(4, 1, 5)).toBe(0)
    expect(stepMatch(0, -1, 5)).toBe(4)
    expect(stepMatch(2, -1, 5)).toBe(1)
    expect(stepMatch(0, 1, 0)).toBe(0)
  })
})
