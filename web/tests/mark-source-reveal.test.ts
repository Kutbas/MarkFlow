/** 标记源码展开（Typora 模型）：邻近展开为字面源码、离开合拢、符号被删保持字面 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { markSourceRevealKey, markSourceRevealPlugin } from '../src/components/mark-source-reveal'
import { escapeInputPlugin } from '../src/components/escape-input'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function stateWith(md: string, pos?: number): EditorState {
  const doc = h.parse(md) as PMNode
  const plugins = [markSourceRevealPlugin as never, escapeInputPlugin as never]
  const sel =
    pos === undefined
      ? undefined
      : TextSelection.create(doc, pos)
  return EditorState.create({ doc, plugins, selection: sel })
}

/** 状态应用后（appendTransaction 会在 apply 时级联执行）读取展开态与文本 */
function apply(st: EditorState, tr: Parameters<EditorState['apply']>[0]): EditorState {
  return st.apply(tr)
}

function docText(st: EditorState): string {
  return st.doc.textContent
}

function strongRange(st: EditorState): [number, number] | null {
  let r: [number, number] | null = null
  st.doc.descendants((n, p) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'strong') && !r) r = [p, p + n.nodeSize]
  })
  return r
}

describe('markSourceReveal（Typora 源码展开模型）', () => {
  it('光标紧邻加粗区（c 位）→ 展开为字面 **MM**（符号成真实字符）', () => {
    // 'XXX**MM**YYY'：MM 在 pos 4-6，c 位 pos 4
    const st = stateWith('XXX**MM**YYY\n', 4)
    // appendTransaction 已在 create 时跑过（init 后首帧？——init 不触发 append；手动触发一次）
    const st2 = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(st2)).toContain('**MM**')
    expect(strongRange(st2)).toBeNull() // 已展开：无加粗标记
  })

  it('展开后光标离开且符号完好 → 合拢回渲染态', () => {
    const st = stateWith('XXX**MM**YYY\n')
    // 光标进入 c 位（展开）
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**MM**')
    // 光标离开（文档末尾）——离展开区 ≥2
    const imploded = apply(revealed, revealed.tr.setSelection(TextSelection.create(revealed.doc, revealed.doc.content.size - 1)))
    // 合拢后：字面 ** 消失（回到标记渲染态），文本内容不变
    expect(docText(imploded)).not.toContain('**')
    expect(docText(imploded)).toContain('XXXMMYYY')
    // 合拢只还原 strong（syntax 反推 emphasis 误命中的回归防护）
    const range = strongRange(imploded)
    expect(range).not.toBeNull()
    if (range) {
      const node = imploded.doc.nodeAt(range[0])
      const names = node ? node.marks.map((m) => m.type.name) : []
      expect(names).toEqual(['strong'])
    }
    expect(strongRange(imploded)).not.toBeNull()
  })

  it('第一个 * 前输入文本 → 离开 → 正常恢复加粗（新文本留在区外）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**MM**')
    // 在第一个 * 前（pos 4）输入 A
    const typed = apply(revealed, revealed.tr.insertText('A', 4))
    expect(docText(typed)).toContain('XA**MM**')
    // 光标离开
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1)))
    expect(docText(left)).toContain('XXXAMM')
    const range = strongRange(left)
    expect(range).not.toBeNull()
    if (range) {
      const node = left.doc.nodeAt(range[0])
      expect(node?.textContent).toBe('MM')
      expect(node?.marks.map((m) => m.type.name)).toEqual(['strong'])
    }
  })

  it('最后一个 * 后输入文本 → 立即合拢（新文本在区外为普通）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    // 光标放最后一个 * 后（to=10）输入 B
    const typed = apply(revealed, revealed.tr.insertText('B', 10))
    // 光标在 B 后（to+1）→ 已在构造体外 → 合拢
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1)))
    expect(docText(left)).toContain('XXXMMB')
    const range = strongRange(left)
    expect(range).not.toBeNull()
    if (range) {
      const node = left.doc.nodeAt(range[0])
      expect(node?.textContent).toBe('MM')
    }
  })

  it('删除一个 * 后离开 → 保持字面（加粗消失，剩余符号保留）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    // 在字面 **MM** 中删掉第二个 *（位置：4=第一个*，5=第二个*，光标放 5 删左侧）
    const afterDel = apply(
      revealed,
      revealed.tr.delete(4, 5), // 删第一个 *
    )
    expect(docText(afterDel)).toContain('*MM**')
    // 光标离开
    const left = apply(
      afterDel,
      afterDel.tr.setSelection(TextSelection.create(afterDel.doc, afterDel.doc.content.size - 1)),
    )
    // 保持字面：*MM**（3 个 * 保留，无加粗标记）
    expect(docText(left)).toContain('*MM**')
    expect(strongRange(left)).toBeNull()
  })
})


describe('转义（\\* = 原生 *）', () => {
  it('内容含字面 * 的加粗：展开显示转义形态 **a\\*b**，合拢还原 a*b 加粗', () => {
    // 直接 schema 构造（tr.addMark 会因选区邻近触发即时展开）
    const base = stateWith('远\n') // 首段放远端选区
    const schema = base.schema
    const strong = schema.marks['strong']!.create()
    const para = schema.nodes.paragraph.create(null, schema.text('a*b', [strong]))
    const doc = schema.topNodeType.create(null, [base.doc.firstChild!, para])
    const st = EditorState.create({ doc, plugins: [markSourceRevealPlugin as never], selection: TextSelection.create(doc, 1) })
    const r0 = strongRange(st)
    expect(r0).not.toBeNull()
    // 邻近展开 → 源码形态 **a\*b**（内容里的字面 * 转义显示）
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, (r0 as [number, number])[0])))
    expect(docText(revealed)).toContain('**a\\*b**')
    // 离开（回首段）→ 合拢还原加粗 a*b
    const imploded = apply(revealed, revealed.tr.setSelection(TextSelection.create(revealed.doc, 1)))
    const range = strongRange(imploded)
    expect(range).not.toBeNull()
    if (range) expect(imploded.doc.nodeAt(range[0])?.textContent).toBe('a*b')
  })

  it('定界符被转义（\\ 前置）→ 破形离开：\\* 结算为原生 *，全部为普通文本', () => {
    const st = stateWith('**MM**\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 1)))
    expect(docText(revealed)).toBe('**MM**')
    // 在第一个 * 前（pos 1）插入 \\（转义定界符）
    const typed = apply(revealed, revealed.tr.insertText('\\', 1))
    expect(docText(typed)).toBe('\\**MM**')
    // 离开（放 pos 1，\\ 之前——展开区 from 已映射到 \\ 之后）
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, 1)))
    expect(docText(left)).toBe('**MM**')
    expect(strongRange(left)).toBeNull()
  })

  it('渲染视图输入 \\*：反斜杠消耗，插入原生 *（escapeInputPlugin）', () => {
    const st = stateWith('普通文本\n')
    const withBs = apply(st, st.tr.insertText('\\', 5))
    const handler = (escapeInputPlugin.props as { handleTextInput: (v: never, f: number, t: number, s: string) => boolean }).handleTextInput
    const view = { state: withBs, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { view.state = view.state.apply(tr) } } as never
    // 光标在 \\ 后（pos 6）输入 *
    const handled = handler(view, 6, 6, '*')
    expect(handled).toBe(true)
    expect(docText((view as unknown as { state: EditorState }).state)).toBe('普通文本*')
  })
})
