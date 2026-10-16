/** 斜体空格分词（方向键 escape 已被光标侧守护方案取代，相关用例移除） */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { smartToggleMark } from '../src/components/typora-keymap'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

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
