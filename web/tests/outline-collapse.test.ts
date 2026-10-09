import { describe, expect, it } from 'vitest'
import { outlineHasChildren, outlineKey, visibleOutlineIndexes } from '../src/components/Outline'

const OUTLINE = [
  { level: 1, text: 'H1' },
  { level: 2, text: 'H2a' },
  { level: 3, text: 'H3' },
  { level: 4, text: 'H4' },
  { level: 2, text: 'H2b' },
  { level: 3, text: 'H3b' },
  { level: 1, text: 'H1b' },
]

const keys = (...items: Array<{ level: number; text: string }>) =>
  new Set(items.map(outlineKey))

describe('大纲折叠可见性', () => {
  it('无折叠时全部可见', () => {
    expect(visibleOutlineIndexes(OUTLINE, new Set())).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('折叠 H2a：其后更深标题隐藏，直到下一个同级 H2b', () => {
    expect(visibleOutlineIndexes(OUTLINE, keys({ level: 2, text: 'H2a' }))).toEqual([0, 1, 4, 5, 6])
  })

  it('折叠 H1：整个章节（含子级 H2/H3/H4）隐藏', () => {
    expect(visibleOutlineIndexes(OUTLINE, keys({ level: 1, text: 'H1' }))).toEqual([0, 6])
  })

  it('嵌套折叠互不影响', () => {
    expect(visibleOutlineIndexes(OUTLINE, keys({ level: 1, text: 'H1' }, { level: 1, text: 'H1b' }))).toEqual([0, 6])
  })

  it('折叠叶子标题无效果', () => {
    expect(visibleOutlineIndexes(OUTLINE, keys({ level: 4, text: 'H4' }))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('同级同文的重复标题一起折叠（文本键折中语义）', () => {
    const dup = [
      { level: 2, text: '同文' },
      { level: 3, text: 'x' },
      { level: 2, text: '同文' },
      { level: 3, text: 'y' },
    ]
    expect(visibleOutlineIndexes(dup, keys({ level: 2, text: '同文' }))).toEqual([0, 2])
  })

  it('hasChildren 判定', () => {
    expect(outlineHasChildren(OUTLINE, 0)).toBe(true) // H1 后是 H2
    expect(outlineHasChildren(OUTLINE, 3)).toBe(false) // H4 后是 H2（变浅）
    expect(outlineHasChildren(OUTLINE, 6)).toBe(false) // 末尾
  })
})

describe('formatOutlineText（大纲 LaTeX 符号化）', async () => {
  const { formatOutlineText } = await import('../src/components/Outline')
  it('常见希腊字母与运算符替换', () => {
    expect(formatOutlineText('正则化参数 \\lambda')).toBe('正则化参数 λ')
    expect(formatOutlineText('\\alpha 到 \\omega')).toBe('α 到 ω')
    expect(formatOutlineText('a \\times b \\leq c')).toBe('a × b ≤ c')
  })
  it('text/mathbf 包裹剥壳', () => {
    expect(formatOutlineText('\\text{F1} 分数')).toBe('F1 分数')
    expect(formatOutlineText('\\mathbf{64} MHz')).toBe('64 MHz')
  })
  it('普通文本不动', () => {
    expect(formatOutlineText('嵌入式历史与生态')).toBe('嵌入式历史与生态')
  })
})
