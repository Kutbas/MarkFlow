/**
 * Typora 风格快捷键（叠加在 milkdown 内置 Mod-Alt-* 系列之上）：
 * - 段落 Mod-0 / 标题 Mod+1~6 / 升降级 Mod+= / Mod+-
 * - 代码块 mac=Mod-Alt-k、win=Mod-Shift-k（Typora 双平台习惯不同，都绑）
 * - 公式块 Mod-Shift-m / 引用 Mod-Shift-q
 * - 行内代码 Ctrl-`（mac 的 Cmd+Shift+` 多数键盘/输入法按不出）、Mod-Shift-`（win）
 * - 列表 Mod-Alt-]/[（mac：Cmd+Shift+]/[ 是 Chrome 切标签页保留键）、Mod-Shift-]/[（win）
 * - 删除线 Mod-Shift-s；另有 milkdown 内置 Mod-e（行内代码）、Mod-Alt-7/8（列表）
 * 注：表格 Cmd+T、源码模式 Cmd+/ 是浏览器保留键，无法绑定。
 */
import { chainCommands, setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands'
import { keymap } from '@milkdown/kit/prose/keymap'
import { TextSelection, NodeSelection } from '@milkdown/kit/prose/state'
import type { Command } from '@milkdown/kit/prose/state'
import { findWrapping } from '@milkdown/kit/prose/transform'

/** 标题升降级：段落升级为 H6；已是标题则 level±1（clamp 1-6） */
function changeHeadingLevel(delta: number): Command {
  return (state, dispatch) => {
    const headingType = state.schema.nodes['heading']
    if (!headingType) return false
    const { $from } = state.selection
    const node = $from.parent
    if (node.type !== headingType) {
      // 升级方向（Typora Ctrl+Shift+=）：段落 → H6；降级方向段落无操作
      if (delta < 0) return setBlockType(headingType, { level: 6 })(state, dispatch)
      return false
    }
    const current = node.attrs['level'] as number
    const level = Math.min(6, Math.max(1, current + delta))
    if (level === current) return false
    if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, level }))
    return true
  }
}

/** 转换当前文本块为指定节点（段落/标题/代码块/公式块）；
 *  toggle 模式（代码块/公式块）：已是目标类型时再按变回普通段落 */
function turnInto(nodeName: string, attrs?: Record<string, unknown>, toggle = false): Command {
  return (state, dispatch) => {
    const type = state.schema.nodes[nodeName]
    if (!type) return false
    if (toggle && state.selection.$from.parent.type === type) {
      return turnInto('paragraph')(state, dispatch)
    }
    return setBlockType(type, attrs)(state, dispatch)
  }
}

/** Typora 式格式切换（加粗/斜体/行内代码）：
 *  有选区 → 常规 toggle（选区内切换）；
 *  无选区且光标在该格式区域内 → 从光标向两侧扩展出连续区域整体取消；
 *  无选区且光标在普通文本 → 整行（父文本块全部内容）应用格式 */
export function smartToggleMark(markName: string): Command {
  return (state, dispatch) => {
    const markType = state.schema.marks[markName]
    if (!markType) return false
    const { empty, $from } = state.selection
    if (!empty) return toggleMark(markType)(state, dispatch)

    if (markType.isInSet($from.marks())) {
      const blockStart = $from.start()
      const blockEnd = $from.end()
      let from = $from.pos
      let to = $from.pos
      // nodeAt(p) 即字符 [p, p+1) 所属节点（marks() 按位置前方判定，边界字符会漏判）
      const charHasMark = (p: number) => {
        const n = state.doc.nodeAt(p)
        return !!n && !!markType.isInSet(n.marks)
      }
      while (from > blockStart && charHasMark(from - 1)) from--
      while (to < blockEnd && charHasMark(to)) to++
      if (dispatch) dispatch(state.tr.removeMark(from, to, markType))
      return true
    }
    // 无选区 + 普通文本：以空格为界取当前词应用格式（Typora 词级标注）——
    //  "对于 token 而言"光标在 token 内 → 只标 token；整行无空格（纯中文句）
    //  时词=整行，行为与旧的整行应用一致
    const blockStart = $from.start()
    const blockEnd = $from.end()
    // textBetween 取位置 p 处的单个字符（nodeAt 返回整节点取不到字符）
    const isSpace = (p: number): boolean => {
      const ch = state.doc.textBetween(p, p + 1)
      return ch === '' || /\s/.test(ch)
    }
    let from = $from.pos
    let to = $from.pos
    while (from > blockStart && !isSpace(from - 1)) from--
    while (to < blockEnd && !isSpace(to)) to++
    if (from >= to) return true // 光标紧邻空格/空行：无词可标，吞掉按键不做事
    if (dispatch) dispatch(state.tr.addMark(from, to, markType.create()))
    return true
  }
}

/**
 * 行内格式边界的光标交互（最终方案 v4：最小拦截 + 精确落位）。
 * 用户规格（^=光标，**1234** 加粗）：
 *   a. X**^1234**X（区内左端）输入=加粗；b. **1234^**X（区内右端）输入=加粗；
 *   c. X^**1234**X（区前）输入=普通；  d. **1234**^X（区后）输入=普通。
 * 语义 = DOM 光标在标记元素内侧/外侧，浏览器原生输入（含 IME）随侧而定。
 * PM 的位置层把 b/d（及 a/c）折叠为同一位置，且会在事务后把 DOM 光标
 * 改写回左偏置（内侧）——所以只在两种"同位置过界"处拦截（其余全部原生）：
 *   ➡️ 于 b 型边界（左字符带标记、右侧无此标记）→ 落位外侧（domAtPos）；
 *   ⬅️ 于 d 型边界（同上形态，来自右侧）→ 落位内侧（标记文本节点末尾）。
 * 落位后由 selectionchange 兜底：同位置的 PM 改写会被恢复到落点。
 */

interface SideView {
  state: Parameters<Command>[0]
  dom: HTMLElement
  domAtPos(pos: number, bias?: number): { node: Node; offset: number }
  nodeDOM(pos: number): Node | null
}

let placedSide: { pos: number; node: Node; offset: number } | null = null
let composingSide = false

function setDomCaret(node: Node, offset: number): void {
  try {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  } catch {
    /* 落位失败不影响原生行为 */
  }
}

/** b/d 型边界：左字符带标记、右侧无此标记（右侧可为空=行尾） */
function boldEndBoundary(
  state: Parameters<Command>[0],
): { prevMarked: boolean } | null {
  const sel = state.selection
  if (!sel.empty) return null
  const $from = sel.$from
  const prev = state.doc.nodeAt($from.pos - 1)
  const next = state.doc.nodeAt($from.pos)
  if (!prev || !prev.isText) return null
  if (next && !next.isText) return null
  const prevHas = prev.marks.length > 0
  if (!prevHas) return null
  const nextLacks =
    !next || !next.marks.some((m) => prev.marks.some((p) => p.type === m.type))
  return nextLacks ? { prevMarked: true } : null
}

export function attachCaretSideKeeper(getView: () => SideView | null): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || e.isComposing) return
    const target = e.target as HTMLElement | null
    if (!target?.closest?.('.ProseMirror')) return
    const view = getView()
    if (!view) return
    if (!boldEndBoundary(view.state)) return
    const pos = view.state.selection.from
    if (e.key === 'ArrowRight') {
      // b → d：落位外侧（普通侧）。吞键——放行原生会落到不确定侧/跨字
      e.preventDefault()
      const at = view.domAtPos(pos)
      setDomCaret(at.node, at.offset)
      placedSide = { pos, node: at.node, offset: at.offset }
    } else {
      // d → b：落位内侧（标记文本节点末尾）。吞键——原生从外侧左移的落点侧不定。
      // nodeDOM 对文本内部位置返回 null（它找"位置后节点"）——用 domAtPos 左偏置
      // （bias -1）拿到边界内侧：标记文本节点末尾
      e.preventDefault()
      const at = view.domAtPos(pos, -1)
      setDomCaret(at.node, at.offset)
      placedSide = { pos, node: at.node, offset: at.offset }
    }
  }
  const readSel = (): void => {
    if (!placedSide || composingSide) return
    const view = getView()
    if (!view) return
    const sel = view.state.selection
    if (!sel.empty || sel.from !== placedSide.pos) {
      placedSide = null
      return
    }
    const domSel = window.getSelection()
    if (!domSel || domSel.anchorNode !== placedSide.node || domSel.anchorOffset !== placedSide.offset) {
      // PM 事务把 DOM 光标改写回左偏置：恢复用户按键选定的侧
      if (placedSide.node.isConnected) setDomCaret(placedSide.node, placedSide.offset)
    }
  }
  const onCompStart = (): void => {
    composingSide = true
  }
  const onCompEnd = (): void => {
    composingSide = false
    placedSide = null
  }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('selectionchange', readSel)
  document.addEventListener('compositionstart', onCompStart)
  document.addEventListener('compositionend', onCompEnd)
  return () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('selectionchange', readSel)
    document.removeEventListener('compositionstart', onCompStart)
    document.removeEventListener('compositionend', onCompEnd)
  }
}

/** wrap 当前块（引用/列表） */
function wrapInBy(nodeName: string): Command {
  return (state, dispatch) => {
    const type = state.schema.nodes[nodeName]
    if (!type) return false
    return wrapIn(type)(state, dispatch)
  }
}

export function toggleTaskList(state: Parameters<Command>[0], dispatch?: Parameters<Command>[1]): boolean {
  const itemType = state.schema.nodes['list_item']
  if (!itemType) return false
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type === itemType) {
      const isTask = node.attrs['checked'] != null
      if (dispatch) {
        dispatch(
          state.tr.setNodeMarkup($from.before(d), undefined, {
            ...node.attrs,
            checked: isTask ? null : false,
          }),
        )
      }
      return true
    }
  }
  // 不在列表：wrap 无序列表后，list_item 位于 range.from + 1（list 开标签后）
  const listType = state.schema.nodes['bullet_list']
  if (!listType) return false
  const range = $from.blockRange()
  if (!range) return false
  const wrapping = findWrapping(range, listType)
  if (!wrapping) return false
  if (dispatch) {
    const tr = state.tr.wrap(range, wrapping)
    // range 涵盖原块：其起点（$from.before(depth+1)）在 wrap 后是 bullet_list，
    // list_item 在其后 1（depth=共同祖先层，块的直接父是 depth+1 层）
    tr.setNodeMarkup(range.$from.before(range.depth + 1) + 1, undefined, { checked: false })
    dispatch(tr)
  }
  return true
}

/** 块首 Backspace 且前一个兄弟节点是分隔线（hr）：直接删除（Typora 行为）。
 *  PM 默认对原子节点是先 NodeSelection 选中、再按一次才删——两步变一步 */
export function backspaceDeletePrevHr(
  state: Parameters<Command>[0],
  dispatch?: Parameters<Command>[1],
): boolean {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const parentDepth = $from.depth - 1
  if (parentDepth < 0) return false
  const index = $from.index(parentDepth)
  if (index === 0) return false
  const prev = $from.node(parentDepth).child(index - 1)
  if (!prev || prev.type.name !== 'hr') return false
  const hrPos = $from.before($from.depth) - prev.nodeSize
  if (dispatch) dispatch(state.tr.delete(hrPos, hrPos + prev.nodeSize))
  return true
}

/** 标题行首 Backspace：变普通段落（Typora 行为）。仅在标题块开头且选区为空时
 *  接管，其余场景返回 false 走默认删除链 */
export function headingBackspaceToParagraph(
  state: Parameters<Command>[0],
  dispatch?: Parameters<Command>[1],
): boolean {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  if ($from.parent.type.name !== 'heading') return false
  const paraType = state.schema.nodes['paragraph']
  if (!paraType) return false
  if (dispatch) {
    dispatch(state.tr.setBlockType($from.before(), $from.after(), paraType))
  }
  return true
}

/** Typora 式 Cmd+A：光标在隔离块（代码块/公式块）内 → 全选该块内容；
 *  在表格内 → 选中整个表格（NodeSelection 可整体删除/复制）；
 *  已选中块范围再按 → 放行默认（全文档）。其余场景默认全选 */
export function smartSelectAll(
  state: Parameters<Command>[0],
  dispatch?: Parameters<Command>[1],
): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d)
    const start = $from.before(d)
    if (n.type.name === 'code_block' || n.type.name === 'math_block') {
      const from = start + 1
      const to = start + n.nodeSize - 1
      // 已选中该块内容 → 走默认全文档
      if (state.selection.from === from && state.selection.to === to) return false
      if (dispatch) {
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
      }
      return true
    }
    if (n.type.name === 'table') {
      if (state.selection instanceof NodeSelection && state.selection.from === start) return false
      if (dispatch) {
        dispatch(state.tr.setSelection(NodeSelection.create(state.doc, start)))
      }
      return true
    }
  }
  return false
}

export const typoraShortcuts: Record<string, Command> = {
  'Mod-a': smartSelectAll,
  // 加粗/斜体：Typora 式（光标在格式区内直接切换整段；无选区普通文本整行应用）
  'Mod-b': smartToggleMark('strong'),
  'Mod-i': smartToggleMark('emphasis'),
  'Mod-0': turnInto('paragraph'),
  'Mod-1': turnInto('heading', { level: 1 }),
  'Mod-2': turnInto('heading', { level: 2 }),
  'Mod-3': turnInto('heading', { level: 3 }),
  'Mod-4': turnInto('heading', { level: 4 }),
  'Mod-5': turnInto('heading', { level: 5 }),
  'Mod-6': turnInto('heading', { level: 6 }),
  'Mod-=': changeHeadingLevel(-1),
  'Mod--': changeHeadingLevel(1),
  // Backspace：块首前是分隔线 → 一步删除；标题块首 → 直转段落；其余走默认
  Backspace: chainCommands(backspaceDeletePrevHr, headingBackspaceToParagraph),
  // 代码块：Typora mac 用 Cmd+Option+K，win 用 Ctrl+Shift+K，双绑定各取所需；
  // 在代码块内再按 = 取消代码块变回段落（toggle）
  'Mod-Alt-k': turnInto('code_block', undefined, true),
  'Mod-Shift-k': turnInto('code_block', undefined, true),
  'Mod-Shift-m': turnInto('math_block', undefined, true),
  // 行内代码：Ctrl-` 双平台都无冲突；Mod-Shift-` 保留给 Windows
  'Ctrl-`': smartToggleMark('inlineCode'),
  'Mod-Shift-`': smartToggleMark('inlineCode'),
  // 覆盖 milkdown 内置 Mod-e（行内代码）：同为 smart 版
  'Mod-e': smartToggleMark('inlineCode'),
  'Mod-Shift-q': wrapInBy('blockquote'),
  // 列表：mac 的 Cmd+Shift+]/[ 被 Chrome 占用（切标签页）——Alt 组合版各平台可用
  'Mod-Alt-]': wrapInBy('bullet_list'),
  'Mod-Alt-[': wrapInBy('ordered_list'),
  'Mod-Shift-]': wrapInBy('bullet_list'),
  'Mod-Shift-[': wrapInBy('ordered_list'),
  // 任务列表：接内置列表系列（Mod-Alt-7 有序 / Mod-Alt-8 无序）之后的 9
  'Mod-Alt-9': toggleTaskList,
  'Mod-Shift-s': smartToggleMark('strike_through'),
}

export function typoraKeymapPlugin() {
  return keymap(typoraShortcuts)
}
