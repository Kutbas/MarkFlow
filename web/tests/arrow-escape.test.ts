/** 行内格式边界逃逸（➡️ 跳出标记区 / ⬅️ 不跨字符）+ 斜体空格分词 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { arrowEscapeMark, markBoundaryInputPlugin, smartToggleMark } from '../src/components/typora-keymap'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function viewAt(md: string, pos: number) {
  const doc = h.parse(md) as PMNode
  const st = EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
  const view = {
    state: st,
    dispatch: (tr: Parameters<EditorState['apply']>[0]) => {
      view.state = view.state.apply(tr)
    },
    focus: () => {},
  } as never
  return view
}

function markNames(view: never): string[] {
  const st = (view as unknown as { state: EditorState }).state
  return (st.storedMarks ?? st.selection.$from.marks()).map((m) => m.type.name)
}

describe('斜体空格分词', () => {
  it('光标在词内：Cmd+I 只斜体当前词', () => {
    const doc = h.parse('对于 token 而言\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, 6) })
    const view = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { (view as { state: EditorState }).state = st.apply(tr) }, focus: () => {} } as never
    expect(smartToggleMark('emphasis')((view as unknown as { state: EditorState }).state, (view as unknown as { dispatch: (t: never) => void }).dispatch)).toBe(true)
    let marked = ''
    ;((view as unknown as { state: EditorState }).state.doc as PMNode).descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'emphasis')) marked += n.textContent
    })
    expect(marked).toBe('token')
  })
})

describe('arrowEscapeMark 右向逃逸', () => {
  it('行尾加粗区末端：就地清上下文（位置不动，可继续输入普通文本）', () => {
    // '**加粗文字**' → 1加2粗3文4字，块尾 pos 5
    const view = viewAt('**加粗文字**\n', 5)
    expect(markNames(view)).toContain('strong') // 左偏置：上下文仍是加粗
    expect(arrowEscapeMark('right')((view as unknown as { state: EditorState }).state, (view as unknown as { dispatch: (t: never) => void }).dispatch)).toBe(true)
    expect(markNames(view)).toEqual([])
    expect((view as unknown as { state: EditorState }).state.selection.from).toBe(5)
  })

  it('加粗后跟普通文本的边界：就地切换上下文为普通（不跨字符）', () => {
    // '**bold**plain' → 1b2o3l4d | 5p...
    const view = viewAt('**bold**plain\n', 5)
    expect(arrowEscapeMark('right')((view as unknown as { state: EditorState }).state, (view as unknown as { dispatch: (t: never) => void }).dispatch)).toBe(true)
    expect(markNames(view)).toEqual([])
    expect((view as unknown as { state: EditorState }).state.selection.from).toBe(5)
  })

  it('普通文本内不拦截（走默认右移）', () => {
    const view = viewAt('plain text\n', 3)
    expect(arrowEscapeMark('right')((view as unknown as { state: EditorState }).state, undefined)).toBe(false)
  })
})

describe('输入时刻边界兜底（markBoundaryInputPlugin.handleTextInput）', () => {
  const plugin = markBoundaryInputPlugin()
  const handler = (plugin.props as { handleTextInput: (view: never, from: number, to: number, text: string) => boolean }).handleTextInput

  it('光标在加粗区末端（行尾）输入：文本不带加粗', () => {
    // '**加粗文字**' 块尾 pos 5
    const view = viewAt('**加粗文字**\n', 5)
    expect(handler(view, 5, 5, '新')).toBe(true)
    const st = (view as unknown as { state: EditorState }).state
    expect(st.doc.textContent).toContain('加粗文字新')
    let bold = false
    st.doc.descendants((n) => {
      if (n.isText && n.textContent.includes('新')) bold = n.marks.some((m) => m.type.name === 'strong')
    })
    expect(bold).toBe(false)
  })

  it('光标在加粗区中间输入：延续加粗（兜底不拦截）', () => {
    const view = viewAt('**加粗文字**\n', 3)
    expect(handler(view, 3, 3, '新')).toBe(false)
  })

  it('普通文本输入：不拦截', () => {
    const view = viewAt('普通文本\n', 3)
    expect(handler(view, 3, 3, '新')).toBe(false)
  })
})

describe('arrowEscapeMark 左向落位', () => {
  it('从普通字符左移到加粗边界：上下文取右侧普通字符（渲染在它前面，不被拉回加粗）', () => {
    // 光标在 pos 6（p 与 l 之间）→ 左移落 5（d 与 p 边界），上下文应为普通
    const view = viewAt('**bold**plain\n', 6)
    expect(arrowEscapeMark('left')((view as unknown as { state: EditorState }).state, (view as unknown as { dispatch: (t: never) => void }).dispatch)).toBe(true)
    const st = (view as unknown as { state: EditorState }).state
    expect(st.selection.from).toBe(5)
    expect(st.storedMarks ?? []).toEqual([])
  })

  it('普通文本内左移不拦截', () => {
    const view = viewAt('plain text\n', 4)
    expect(arrowEscapeMark('left')((view as unknown as { state: EditorState }).state, undefined)).toBe(false)
  })
})
