import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, NodeSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { smartSelectAll } from '../src/components/typora-keymap'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function viewOf(state: EditorState) {
  const v = {
    state,
    dispatch(tr: Parameters<EditorState['apply']>[0]) {
      v.state = v.state.apply(tr)
    },
    focus: () => {},
  }
  return v
}

/** 光标放进指定类型节点的文本中 */
function cursorIn(doc: PMNode, typeName: string): number {
  let pos = 1
  doc.descendants((n, p) => {
    if (pos !== 1 || n.type.name !== typeName) return true
    pos = p + 2
    return false
  })
  return pos
}

describe('smartSelectAll（块内 Cmd+A）', () => {
  it('代码块内：全选块内容', () => {
    const doc = h.parse('前文\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n后文\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, cursorIn(doc, 'code_block')) })
    const v = viewOf(st)
    expect(smartSelectAll(v.state as never, v.dispatch as never)).toBe(true)
    const sel = v.state.selection
    // 选区恰为块内容范围（不含围栏）
    const block = (() => { let f: PMNode | null = null; doc.forEach((n, o) => { if (n.type.name === 'code_block' && !f) f = n as never && Object.assign({}, { n, o }) as never }); return null })()
    let from = -1, to = -1
    doc.forEach((n, o) => {
      if (n.type.name === 'code_block' && from < 0) { from = o + 1; to = o + n.nodeSize - 1 }
    })
    expect(sel.from).toBe(from)
    expect(sel.to).toBe(to)
  })

  it('代码块内再按一次（已选块内容）：返回 false 走默认全文档', () => {
    const doc = h.parse('```ts\nabc\n```\n') as PMNode
    let from = -1, to = -1
    doc.forEach((n, o) => { if (n.type.name === 'code_block' && from < 0) { from = o + 1; to = o + n.nodeSize - 1 } })
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, from, to) })
    expect(smartSelectAll(st as never, undefined)).toBe(false)
  })

  it('公式块内：全选公式内容', () => {
    const doc = h.parse('$$\nE=mc^2\n$$\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, cursorIn(doc, 'math_block')) })
    const v = viewOf(st)
    expect(smartSelectAll(v.state as never, v.dispatch as never)).toBe(true)
    let from = -1, to = -1
    doc.forEach((n, o) => { if (n.type.name === 'math_block' && from < 0) { from = o + 1; to = o + n.nodeSize - 1 } })
    expect(v.state.selection.from).toBe(from)
    expect(v.state.selection.to).toBe(to)
  })

  it('表格内：选中整个表格（NodeSelection）', () => {
    const doc = h.parse('| a | b |\n| - | - |\n| 1 | 2 |\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, cursorIn(doc, 'table_cell')) })
    const v = viewOf(st)
    expect(smartSelectAll(v.state as never, v.dispatch as never)).toBe(true)
    expect(v.state.selection instanceof NodeSelection).toBe(true)
    expect(v.state.doc.nodeAt(v.state.selection.from)?.type.name).toBe('table')
  })

  it('普通段落：返回 false 走默认全文档全选', () => {
    const doc = h.parse('普通段落文本\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, 2) })
    expect(smartSelectAll(st as never, undefined)).toBe(false)
  })
})
