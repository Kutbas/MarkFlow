/**
 * 轻量"就地标记"（Typora 行为）：光标进入加粗/斜体/删除线/行内代码区域时，
 * 在该标记区域两端显示原始 Markdown 语法符号（**、*、~~、`），移出即隐去。
 * 实现：ProseMirror inline widget decoration，选区变化时重算。
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
      Decoration.widget(from, () => makeSyntaxEl(syntax), {
        side: -1,
        key: `open-${mark.type.name}-${from}`,
      }),
    )
    decorations.push(
      Decoration.widget(to, () => makeSyntaxEl(syntax), {
        side: 1,
        key: `close-${mark.type.name}-${to}`,
      }),
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

function makeSyntaxEl(syntax: string): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mf-inplace-marking'
  el.textContent = syntax
  el.setAttribute('contenteditable', 'false')
  return el
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
