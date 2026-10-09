import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { backspaceDeletePrevHr } from '../src/components/typora-keymap'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function stateAtBlockStart(md: string): EditorState {
  const doc = h.parse(md) as PMNode
  // 光标放第一个块的块首
  const first = doc.child(0)
  const pos = 1
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

function viewOf(state: EditorState) {
  const v = { state, dispatch(tr: Parameters<EditorState['apply']>[0]) { v.state = v.state.apply(tr) }, focus: () => {} }
  return v
}

describe('backspaceDeletePrevHr（块首退格删分隔线）', () => {
  it('块首且前一个是 hr：一步删除分隔线', async () => {
    const h2 = await getHeadless()
    const doc = h2.parse('---\n\n# 标题\n') as PMNode
    // 光标放标题块首（hr 后）
    let titlePos = -1
    doc.forEach((n, o) => { if (n.type.name === 'heading' && titlePos < 0) titlePos = o })
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, titlePos + 1) })
    const v = viewOf(st)
    expect(backspaceDeletePrevHr(v.state as never, v.dispatch as never)).toBe(true)
    let hrLeft = false
    v.state.doc.forEach((n) => { if (n.type.name === 'hr') hrLeft = true })
    expect(hrLeft).toBe(false)
    expect(v.state.doc.textContent).toContain('标题')
  })

  it('前一个不是 hr（普通段落）：返回 false 走默认', async () => {
    const h2 = await getHeadless()
    const doc = h2.parse('前文段落\n\n# 标题\n') as PMNode
    let titlePos = -1
    doc.forEach((n, o) => { if (n.type.name === 'heading' && titlePos < 0) titlePos = o })
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, titlePos + 1) })
    expect(backspaceDeletePrevHr(st as never, undefined)).toBe(false)
  })

  it('文档首块（无前置）：返回 false', async () => {
    const h2 = await getHeadless()
    const doc = h2.parse('# 标题\n') as PMNode
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, 1) })
    expect(backspaceDeletePrevHr(st as never, undefined)).toBe(false)
  })
})
