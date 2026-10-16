/** 标记源码展开（Typora 模型）：邻近展开为字面源码、离开合拢、符号被删保持字面 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { markSourceRevealKey, markSourceRevealPlugin } from '../src/components/mark-source-reveal'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
})

function stateWith(md: string, pos?: number): EditorState {
  const doc = h.parse(md) as PMNode
  const plugins = [markSourceRevealPlugin as never]
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
