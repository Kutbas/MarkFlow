/**
 * 标记源码展开（Typora 本质模型）：光标进入/紧邻标记区域（加粗/斜体/
 * 删除线/行内代码）时，把区域"展开"为字面源码——`**MM**` 的符号变成真实
 * 文本字符：光标可停靠在任意符号前后（原生字符导航）、删除任意符号是
 * 原生字符删除（Typora"删一个 * 加粗消失、其余保留"）。
 * 光标离开展开区时"合拢"：符号序列完好 → 恢复渲染态；被改动过（删了
 * 符号等）→ 保持字面文本不动。
 * 多标记叠加按固定顺序拼接（加粗+斜体 = ***）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

/** 标记 → 语法符号（拼接顺序即多标记时的组合顺序） */
const MARK_ORDER = ['strong', 'emphasis', 'strike_through', 'inlineCode'] as const
const MARK_SYNTAX: Record<string, string> = {
  strong: '**',
  emphasis: '*',
  strike_through: '~~',
  inlineCode: '`',
}

export const markSourceRevealKey = new PluginKey('mfMarkSourceReveal')

interface Revealed {
  /** 展开区（字面 `语法+内容+语法`）的文档范围 */
  from: number
  to: number
  /** 展开时的语法符号序列（如 '**' / '***'），合拢时校验用 */
  syntax: string
}

/** 区域内全部文本的标记集合是否一致（只展开标记齐整的区域） */
function uniformMarks(node: PMNode, from: number, to: number): string[] | null {
  const box: { key?: string } = {}
  let uniform = true
  node.nodesBetween(from, to, (n) => {
    if (!n.isText || !uniform) return
    const key = n.marks.map((m) => m.type.name).sort().join(',')
    if (box.key === undefined) box.key = key
    else if (box.key !== key) uniform = false
  })
  if (!uniform || box.key === undefined) return null
  const names = box.key.split(',').filter(Boolean)
  return names.length > 0 && names.every((n) => MARK_SYNTAX[n] !== undefined) ? names : null
}

function syntaxOf(markNames: string[]): string {
  return MARK_ORDER.filter((m) => markNames.includes(m))
    .map((m) => MARK_SYNTAX[m])
    .join('')
}

/** 光标是否在 [from-1, to+1] 内（展开态的"仍在交互"判定） */
function selectionNear(state: EditorState, from: number, to: number): boolean {
  const { from: f, to: t } = state.selection
  return f >= from - 1 && f <= to + 1 && t >= from - 1 && t <= to + 1
}

/** 找光标紧邻/所在的齐整标记区域（a/b/c/d 四位或区内） */
function regionAt(state: EditorState): { from: number; to: number; syntax: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const parent = $from.parent
  const parentStart = $from.pos - $from.parentOffset
  const pos = $from.pos

  // 扫描父节点内所有文本子节点，找与光标相邻（或包含）的连续同标记段
  const spans: Array<{ from: number; to: number; names: string[] }> = []
  parent.forEach((child, offset) => {
    if (!child.isText || child.marks.length === 0) return
    const absFrom = parentStart + offset
    const absTo = absFrom + child.nodeSize
    // 光标在段内或段的左/右边界
    const adjacent = pos === absFrom || pos === absTo || (pos > absFrom && pos < absTo)
    if (!adjacent) return
    spans.push({ from: absFrom, to: absTo, names: child.marks.map((m) => m.type.name).sort() })
  })
  if (spans.length === 0) return null
  const from = Math.min(...spans.map((s) => s.from))
  const to = Math.max(...spans.map((s) => s.to))
  const names = uniformMarks(state.doc, from, to)
  if (!names) return null
  return { from, to, syntax: syntaxOf(names) }
}

/** 展开区当前内容是否仍是 完好的 语法+内容+语法 */
function intactReveal(state: EditorState, r: Revealed): string | null {
  const text = state.doc.textBetween(r.from, r.to, '\n', ' ')
  const s = r.syntax
  if (text.length >= s.length * 2 && text.startsWith(s) && text.endsWith(s)) {
    return text.slice(s.length, text.length - s.length)
  }
  return null
}

export const markSourceRevealPlugin = new Plugin({
  key: markSourceRevealKey,
  state: {
    init: (): { revealed: Revealed | null } => ({ revealed: null }),
    apply(tr, prev): { revealed: Revealed | null } {
      const metaSelf = tr.getMeta(markSourceRevealKey) as { revealed?: Revealed | null } | undefined
      if (metaSelf && 'revealed' in metaSelf) return { revealed: metaSelf.revealed ?? null }
      if (!tr.docChanged && !tr.selectionSet) return prev
      if (!prev.revealed) return prev
      const { from, to } = prev.revealed
      const mapped = { ...prev.revealed, from: tr.mapping.map(from, -1), to: tr.mapping.map(to, 1) }
      if (mapped.to <= mapped.from) return { revealed: null }
      return { revealed: mapped }
    },
  },
  appendTransaction(trs, _oldState, newState): Transaction | null {
    const self = markSourceRevealKey.getState(newState) as { revealed: Revealed | null }
    const anyOwn = trs.some((t) => t.getMeta(markSourceRevealKey))
    if (anyOwn) return null

    // ① 已展开：光标离开 → 尝试合拢
    if (self.revealed) {
      if (selectionNear(newState, self.revealed.from, self.revealed.to)) return null
      const content = intactReveal(newState, self.revealed)
      if (content === null) {
        // 符号被改动（删除/编辑）→ 保持字面（Typora：格式已破，剩余符号即文本）
        const tr = newState.tr
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      const tr = newState.tr
      const { from, to, syntax } = self.revealed
      // 重新套上标记并删除字面符号
      const markNames = MARK_ORDER.filter((m) => syntax.includes(MARK_SYNTAX[m] as never))
      const marks = markNames.map((n) => newState.schema.marks[n]?.create()).filter(Boolean)
      tr.replaceWith(from, to, newState.schema.text(content, marks as never))
      tr.setMeta(markSourceRevealKey, { revealed: null })
      return tr
    }

    // ② 未展开：光标紧邻/位于标记区域 → 展开
    const region = regionAt(newState)
    if (!region) return null
    const content = newState.doc.textBetween(region.from, region.to, '\n', ' ')
    const tr = newState.tr
    const literal = region.syntax + content + region.syntax
    // replaceWith + 无标记文本节点：insertText 会继承被替换范围的标记（字面 ** 会被加粗）
    tr.replaceWith(region.from, region.to, newState.schema.text(literal))
    tr.setMeta(markSourceRevealKey, {
      revealed: { from: region.from, to: region.from + literal.length, syntax: region.syntax },
    })
    return tr
  },
})
