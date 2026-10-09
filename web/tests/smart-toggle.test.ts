import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { smartToggleMark, typoraShortcuts } from '../src/components/typora-keymap'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function stateWithCursor(md: string, mark: string): EditorState {
  const doc = h.parse(md) as PMNode
  let pos = 1
  doc.descendants((n, p) => {
    if (pos === 1 && n.isText && n.marks.some((m) => m.type.name === mark)) pos = p + 2
    return pos === 1
  })
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

function statePlain(md: string): EditorState {
  const doc = h.parse(md) as PMNode
  return EditorState.create({ doc, selection: TextSelection.create(doc, 2) })
}

function strongCount(doc: PMNode): number {
  let c = 0
  doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'strong')) c += n.nodeSize
  })
  return c
}

describe('smartToggleMark（Typora 式格式切换）', () => {
  it('光标在加粗区域内：Cmd+B 取消整段加粗（无需选中）', () => {
    const st = stateWithCursor('**加粗文本内容**\n', 'strong')
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) }, focus: () => {} } as never
    expect(smartToggleMark('strong')(view.state, view.dispatch)).toBe(true)
    expect(strongCount(view.state.doc)).toBe(0)
    expect(view.state.doc.textContent).toContain('加粗文本内容')
  })

  it('普通文本无选区：Cmd+B 整行加粗', () => {
    const st = statePlain('普通的一行文本\n')
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) }, focus: () => {} } as never
    expect(smartToggleMark('strong')(view.state, view.dispatch)).toBe(true)
    expect(strongCount(view.state.doc)).toBeGreaterThan(0)
  })

  it('光标在行内代码内：取消整段代码格式', () => {
    const st = stateWithCursor('文字 `code inline` 文字\n', 'inlineCode')
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) }, focus: () => {} } as never
    expect(smartToggleMark('inlineCode')(view.state, view.dispatch)).toBe(true)
    let codeLeft = 0
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'inlineCode')) codeLeft++
    })
    expect(codeLeft).toBe(0)
  })

  it('代码块内再按 Cmd+Alt+K：取消代码块变回段落（toggle）', () => {
    const doc = h.parse('```ts\nconst a = 1\n```\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, 3) })
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) }, focus: () => {} } as never
    expect(typoraShortcuts['Mod-Alt-k']!(view.state as never, view.dispatch as never, view as never)).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
  })

  it('普通段落按 Cmd+Alt+K：变代码块（toggle 不影响首次转换）', () => {
    const st = statePlain('普通段落\n')
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) }, focus: () => {} } as never
    expect(typoraShortcuts['Mod-Alt-k']!(view.state as never, view.dispatch as never, view as never)).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('code_block')
  })
})
