/**
 * 轻量"就地标记"（Typora 行为）：光标位于标记区域边界四位（区内左端/右端、
 * 区前/区后）时显示原始 Markdown 语法符号（**、*、~~、`），移开即隐去。
 * 实现：Decoration.attr 给标记元素（strong/em/code/del 等）加 class，
 * 语法符号由 CSS ::before/::after 伪元素渲染——伪元素不参与光标导航
 * （真实 DOM 元素会成为光标的额外停靠点：过界需多按一次方向键、
 * 点击落点解析被干扰），且 class 切换不改 DOM 结构（光标零扰动）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorState } from '@milkdown/kit/prose/state'
import type { Mark, Node as PMNode } from '@milkdown/kit/prose/model'

/** 标记类型 → 语法符号 */
const MARK_SYNTAX: Record<string, string> = {
  strong: '**',
  emphasis: '*',
  strike_through: '~~',
  inlineCode: '`',
}

/** 从光标位置向两侧扩展，找到该 mark 在父节点内的连续范围 */
interface PosLike {
  pos: number
  parentOffset: number
  parent: { forEach(f: (node: PMNode, offset: number, index: number) => void): void }
}
function findMarkRange($pos: PosLike, mark: Mark): [number, number] | null {
  const parent = $pos.parent
  const parentStart = $pos.pos - $pos.parentOffset
  const has = (m: readonly Mark[]) => m.some((x) => x.eq(mark))

  let start = -1
  let end = -1
  parent.forEach((node, offset) => {
    if (!has(node.marks)) return
    const absFrom = parentStart + offset
    const absTo = absFrom + node.nodeSize
    // 覆盖光标位置（光标可在节点右边界，即 parentOffset === offset+nodeSize）
    if (absFrom <= $pos.pos && $pos.pos <= absTo) {
      start = start < 0 ? absFrom : Math.min(start, absFrom)
      end = Math.max(end < 0 ? absTo : end, absTo)
    }
  })
  if (start < 0 || end < 0) return null
  return [start, end]
}

function buildDecorations(state: EditorState): DecorationSet {
  const { selection } = state
  if (!selection.empty) return DecorationSet.empty
  const $from = selection.$from
  const decorations: Decoration[] = []

  // 光标位置处 marks() 是左偏置的：区后（d 位）能命中，区前（c 位）命中不了——
  // 补看右侧字符的标记，使紧贴标记区域两端（a/b/c/d 四位）都显示语法符号
  const marksAt: Mark[] = [...$from.marks()]
  const nextNode = state.doc.nodeAt($from.pos)
  if (nextNode && nextNode.isText) {
    for (const m of nextNode.marks) {
      if (!marksAt.some((x) => x.eq(m))) marksAt.push(m)
    }
  }
  for (const mark of marksAt) {
    const syntax = MARK_SYNTAX[mark.type.name]
    if (!syntax) continue
    const range = findMarkRange($from, mark)
    if (!range) continue
    const [from, to] = range
    decorations.push(
      Decoration.inline(from, to, { class: `mf-show-marks mf-mark-${mark.type.name}` }),
    )
  }
  return DecorationSet.create(state.doc, decorations)
}


export const inplaceMarkingPlugin = new Plugin({
  key: new PluginKey('mfInplaceMarking'),
  state: {
    init: (_, state) => ({ decorations: buildDecorations(state) }),
    apply: (tr, prev, _old, newState) => {
      if (!tr.docChanged && !tr.selectionSet) return prev
      return { decorations: buildDecorations(newState) }
    },
  },
  props: {
    decorations(state: EditorState) {
      return this.getState(state)?.decorations ?? null
    },
  },
})
