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
import { markSourceRevealKey, buildLiteral, parseRevealed, syntaxOf, LINK_NAME, type Revealed } from './mark-source-reveal'
import { dispatchStructure, interceptUndo, interceptRedo } from './structure-undo'
import { useApp } from '../store'

/** 当前文档路径（结构撤销栈的归属标记） */
const docPath = (): string => useApp.getState().currentPath ?? ''

/** 结构命令的 dispatch 包装：经自管撤销栈（y-undo 对结构变换恢复错乱） */
function structuredDispatch(
  dispatch: Parameters<Command>[1],
  view: Parameters<Command>[2] | undefined,
): NonNullable<Parameters<Command>[1]> {
  return (tr) => {
    if (view) dispatchStructure(view as never, docPath(), tr as never)
    else dispatch?.(tr as never)
  }
}

/** 标题升降级：段落升级为 H6；已是标题则 level±1（clamp 1-6） */
function changeHeadingLevel(delta: number): Command {
  return (state, dispatch, view) => {
    const headingType = state.schema.nodes['heading']
    if (!headingType) return false
    const { $from } = state.selection
    const node = $from.parent
    if (node.type !== headingType) {
      // 升级方向（Typora Ctrl+Shift+=）：段落 → H6；降级方向段落无操作
      if (delta < 0) return setBlockType(headingType, { level: 6 })(state, structuredDispatch(dispatch, view))
      return false
    }
    const current = node.attrs['level'] as number
    const level = Math.min(6, Math.max(1, current + delta))
    if (level === current) return false
    if (dispatch) structuredDispatch(dispatch, view)(state.tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, level }))
    return true
  }
}

/** 转换当前文本块为指定节点（段落/标题/代码块/公式块）；
 *  toggle 模式（代码块/公式块）：已是目标类型时再按变回普通段落 */
function turnInto(nodeName: string, attrs?: Record<string, unknown>, toggle = false): Command {
  return (state, dispatch, view) => {
    const type = state.schema.nodes[nodeName]
    if (!type) return false
    if (toggle && state.selection.$from.parent.type === type) {
      return turnInto('paragraph')(state, dispatch, view)
    }
    return setBlockType(type, attrs)(state, structuredDispatch(dispatch, view))
  }
}

/** 展开态感知 toggle：光标/选区落在源码展开区内时按区域元数据切换。
 *  展开区的字面文本（`**内容**`）本身无标记，真实格式在 revealed.markNames
 *  ——不看元数据会把字面 ** 当普通词再叠标记（Ctrl+B 撤销加粗失效的根源），
 *  或撤销后被合拢逻辑按旧名单还原吞掉。
 *  link 无快捷键入口，toggle 只作用于符号 mark；名单含 link 时永不"清空"
 *  （加粗链接撤销加粗 → 字面 [x](u)，链接结构保留）。 */
function revealedToggle(markName: string, state: Parameters<Command>[0], dispatch?: Parameters<Command>[1], view?: Parameters<Command>[2]): boolean {
  const self = markSourceRevealKey.getState(state) as { revealed: Revealed | null } | undefined
  const r = self?.revealed
  if (!r) return false
  const { from: f, to: t } = state.selection
  if (!(f >= r.from && f <= r.to && t >= r.from && t <= r.to)) return false
  // 符号/结构完好才接管（用户删过符号 = 破形字面文本，走普通逻辑）
  const parsed = parseRevealed(
    state.doc.textBetween(r.from, r.to, '\n', ' '),
    r.syntax,
    r.markNames.includes(LINK_NAME),
  )
  if (!parsed) return false
  const has = r.markNames.includes(markName)
  const markNames = has ? r.markNames.filter((n) => n !== markName) : [...r.markNames, markName]
  if (dispatch) {
    const tr = state.tr
    if (markNames.length === 0) {
      // 名单清空：区域消解为纯文本（符号一并消失）——"取消加粗"的正解；
      // 空内容（只剩 ****）连符号带内容整段删除
      if (parsed.content === '') tr.delete(r.from, r.to)
      else tr.replaceWith(r.from, r.to, state.schema.text(parsed.content))
      tr.setMeta(markSourceRevealKey, { revealed: null })
    } else {
      // 重铸字面（符号随名单即时变化，区域保持展开态；link 结构照原地址保留）
      const literal = buildLiteral(markNames, parsed.content, parsed.href)
      tr.replaceWith(r.from, r.to, state.schema.text(literal))
      tr.setMeta(markSourceRevealKey, {
        revealed: { from: r.from, to: r.from + literal.length, syntax: syntaxOf(markNames), markNames },
      })
    }
    // 展开态 toggle 是真实的格式变更：走结构撤销栈（Cmd+Z 可撤）
    structuredDispatch(dispatch, view)(tr as never)
  }
  return true
}

/** Typora 式格式切换（加粗/斜体/行内代码）：
 *  源码展开区内 → 按区域元数据切换（revealedToggle）；
 *  有选区 → 常规 toggle（选区内切换）；
 *  无选区且光标在该格式区域内 → 从光标向两侧扩展出连续区域整体取消；
 *  无选区且光标在普通文本 → 整行（父文本块全部内容）应用格式 */
export function smartToggleMark(markName: string): Command {
  return (state, dispatch, view) => {
    const markType = state.schema.marks[markName]
    if (!markType) return false
    if (revealedToggle(markName, state, dispatch, view)) return true
    const { empty, $from } = state.selection
    if (!empty) return toggleMark(markType)(state, structuredDispatch(dispatch, view))

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
      if (dispatch) structuredDispatch(dispatch, view)(state.tr.removeMark(from, to, markType) as never)
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
    if (dispatch) structuredDispatch(dispatch, view)(state.tr.addMark(from, to, markType.create()) as never)
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
let placedSideMarks: readonly unknown[] = []
let composingSide = false

/** 落位并同步输入上下文：PM 处理打字的快速路径用光标左偏置 marks
 *  （无视 DOM 光标侧），IME/原生输入又随 DOM 落点——两通道必须同时设对，
 *  否则 a 位（区内左端）打字变普通、d 位（区后）打字变加粗 */
function setDomCaret(view: SideView, node: Node, offset: number, marks: readonly unknown[]): void {
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
  try {
    const tr = (view.state as unknown as { tr: { setStoredMarks(m: readonly unknown[]): unknown } }).tr
    tr.setStoredMarks(marks)
    ;(view as unknown as { dispatch(t: unknown): void }).dispatch(tr)
  } catch {
    /* storedMarks 设置失败不影响 DOM 落位 */
  }
}

/** 一般校正（延迟执行版）：以 DOM 侧为准设置 storedMarks——只在 DOM 侧
 *  与左偏置不一致时动作（该状态只可能来自用户/我方落位；PM 左偏置改写产生
 *  的状态与左偏置一致，不会触发，天然无对抗循环） */
function generalCorrect(getView: () => SideView | null): void {
  if (composingSide) return
  const view = getView()
  if (!view) return
  const state = view.state
  const sel = state.selection
  const domSel = window.getSelection()
  if (!sel.empty || !domSel || domSel.rangeCount === 0) return
  const pos = sel.from
  const prev = state.doc.nodeAt(pos - 1)
  const next = state.doc.nodeAt(pos)
  if ((prev && !prev.isText) || (next && !next.isText)) return
  const domNode = domSel.anchorNode
  if (!domNode) return
  const leftBiased = sel.$from.marks()
  const sameMark = (a: { marks: readonly { type: unknown }[] }, b: { marks: readonly { type: unknown }[] }) =>
    a.marks.some((m) => b.marks.some((n) => n.type === m.type))
  const apply = (marks: readonly unknown[]): void => {
    const differ =
      marks.length !== leftBiased.length ||
      !marks.every((m) => leftBiased.some((l) => l.eq(m as Parameters<typeof l.eq>[0])))
    if (differ) setDomCaret(view, domNode, domSel.anchorOffset, marks)
  }
  if (prev && prev.marks.length > 0 && (!next || !sameMark(next, prev))) {
    // 尾边界（b 内侧 / d 外侧）
    apply(domNode === view.domAtPos(pos, -1).node ? prev.marks : next ? next.marks : [])
  } else if (next && next.marks.length > 0 && (!prev || !sameMark(prev, next))) {
    // 首边界（a 内侧 / c 外侧）
    apply(domNode === view.nodeDOM(pos) ? next.marks : prev ? prev.marks : [])
  }
}

/** 需要能读到事务级联后状态的 view 形状（真实 EditorView 结构兼容，
 *  测试用 getter 替身同构） */
interface CascadeView {
  state: Parameters<Command>[0]
  dispatch: (tr: unknown) => void
}

/** 选区坍缩（⬅️）落在标记区起点时光标进内侧（Typora 手感）：
 *  Cmd+Shift+← 选中整词 → Cmd+B（选区保留）→ ⬅️ 坍缩到 from（c 位）→
 *  源码展开把区域变字面 **x**，光标按 PM 位置落在字面最前（|**x**）。
 *  期望 **|x**：坍缩后二次落位到字面开定界符之后（区内起点）。
 *  按 marks 通用判定：斜体/代码/删除线/链接同样生效。
 *  两次 dispatch 同步执行——展开在第一次事务的 appendTransaction 级联内完成 */
export function collapseSelectionIntoMarkLeft(view: CascadeView): boolean {
  const state = view.state
  const { from, empty } = state.selection
  if (empty) return false
  const next = state.doc.nodeAt(from)
  const prev = from > 0 ? state.doc.nodeAt(from - 1) : null
  // 起点 c 形态：坍缩点后是标记文本、前面没有同类标记（区内中间不算）
  if (!next || !next.isText || next.marks.length === 0) return false
  if (prev && prev.marks.some((m) => next.marks.some((n) => n.type === m.type))) return false
  // ① 坍缩到 from → 源码展开字面化（级联）。视图态变换：不进任何撤销栈
  const tr1 = state.tr.setSelection(TextSelection.create(state.doc, from))
  tr1.setMeta('addToHistory', false)
  view.dispatch(tr1)
  // ② 光标进字面开定界符之后；未展开回落 from（与原生坍缩等价）
  const st = view.state
  const revealed = (markSourceRevealKey.getState(st) as { revealed: Revealed | null }).revealed
  const target = revealed && revealed.from === from ? from + revealed.syntax.length : from
  const tr2 = st.tr.setSelection(TextSelection.create(st.doc, target))
  tr2.setMeta('addToHistory', false)
  view.dispatch(tr2)
  return true
}

export function attachCaretSideKeeper(getView: () => SideView | null): () => void {
  /** 删除语法符号 = 剥离格式（Typora"删 ** 即取消加粗"）。
   *  判定全用 PM 状态层（DOM 停靠点不可靠）：光标在标记边界且删除方向
   *  面向语法符号 → removeMark 整个区域。四个入口：
   *  a 位（区内左端）Backspace / c 位（区前）Delete → open **；
   *  b 位（区内右端）Delete / d 位（区后）Backspace → close ** */
  const onBackspace = (e: KeyboardEvent, view: NonNullable<ReturnType<typeof getView>>): void => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return
    const state = view.state
    const sel = state.selection
    if (!sel.empty) return
    const pos = sel.from
    const prev = state.doc.nodeAt(pos - 1)
    const next = state.doc.nodeAt(pos)
    if ((prev && !prev.isText) || (next && !next.isText)) return
    const domSel = window.getSelection()
    if (!domSel || domSel.rangeCount === 0) return
    // DOM 侧（v5.1 的判定）：anchorNode 是否为标记文本节点
    const insideEnd = view.domAtPos(pos, -1)
    const insidePrev = prev && insideEnd.node.nodeType === 3 ? insideEnd.node : null
    const insideNext = next && view.nodeDOM(pos)?.nodeType === 3 ? view.nodeDOM(pos) : null
    const isInside =
      (insidePrev && domSel.anchorNode === insidePrev) || (insideNext && domSel.anchorNode === insideNext)
    // 尾部边界（b/d）：prev 带标记。b（内侧）Delete 删 close；d（外侧）Backspace 删 close
    if (prev && prev.marks.length > 0 && (!next || !next.marks.some((m) => prev.marks.some((p2) => p2.type === m.type)))) {
      if ((e.key === 'Delete' && isInside) || (e.key === 'Backspace' && !isInside)) {
        e.preventDefault()
        const tr = state.tr
        for (const m of prev.marks) tr.removeMark(pos - prev.nodeSize, pos, m)
        ;(view as unknown as { dispatch(t: unknown): void }).dispatch(tr)
      }
      return
    }
    // 起点边界（a/c）：next 带标记。a（内侧）Backspace 删 open；c（外侧）Delete 删 open
    if (next && next.marks.length > 0 && (!prev || !prev.marks.some((m) => next.marks.some((n2) => n2.type === m.type)))) {
      if ((e.key === 'Backspace' && isInside) || (e.key === 'Delete' && !isInside)) {
        e.preventDefault()
        const tr = state.tr
        for (const m of next.marks) tr.removeMark(pos, pos + next.nodeSize, m)
        ;(view as unknown as { dispatch(t: unknown): void }).dispatch(tr)
      }
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) {
      return
    }
    const target0 = e.target as HTMLElement | null
    const view0 = getView()
    if (target0?.closest?.('.ProseMirror') && view0 && (e.key === 'Backspace' || e.key === 'Delete')) {
      onBackspace(e, view0)
      return
    }
    if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
    const target = e.target as HTMLElement | null
    if (!target?.closest?.('.ProseMirror')) return
    const view = getView()
    if (!view) return
    const state = view.state
    const sel = state.selection
    if (!sel.empty) return
    const domSel = window.getSelection()
    if (!domSel || domSel.rangeCount === 0) return
    const pos = sel.from

    const prev = state.doc.nodeAt(pos - 1)
    const next = state.doc.nodeAt(pos)
    if (prev && !prev.isText) return
    if (next && !next.isText) return

    // ---- 尾部边界（区内右端 b / 区后 d）----
    if (prev && prev.marks.length > 0 && (!next || !next.marks.some((m) => prev.marks.some((p) => p.type === m.type)))) {
      const insideEnd = view.domAtPos(pos, -1) // 标记文本节点末尾（内侧）
      const isInside = domSel.anchorNode === insideEnd.node
      if (e.key === 'ArrowRight' && isInside) {
        // b → d：跳出（外侧）。放行原生会跨过边界后的普通字符
        e.preventDefault()
        const at = view.domAtPos(pos) // 默认 bias = 外侧
        setDomCaret(view, at.node, at.offset, next ? next.marks : [])
        placedSide = { pos, node: at.node, offset: at.offset }
        placedSideMarks = next ? next.marks : []
      } else if (e.key === 'ArrowLeft' && !isInside) {
        // d → b：进入（内侧末尾）
        e.preventDefault()
        setDomCaret(view, insideEnd.node, insideEnd.offset, prev.marks)
        placedSide = { pos, node: insideEnd.node, offset: insideEnd.offset }
        placedSideMarks = prev.marks
      }
      // 其余组合（内侧⬅️ / 外侧➡️）：放行原生，位置将正常变化
      return
    }

    // ---- 起点边界（区前 c / 区内左端 a）----
    if (next && next.marks.length > 0 && (!prev || !prev.marks.some((m) => next.marks.some((n) => n.type === m.type)))) {
      // 从该位置开始的节点 = 标记文本节点（nodeDOM 语义即"位置后节点"）
      let insideStart = view.nodeDOM(pos)
      if (insideStart && insideStart.nodeType !== 3) {
        const walker = document.createTreeWalker(insideStart, NodeFilter.SHOW_TEXT)
        if (walker.nextNode()) insideStart = walker.currentNode
      }
      const isInside = !!insideStart && insideStart.nodeType === 3 && domSel.anchorNode === insideStart
      if (e.key === 'ArrowRight' && !isInside && insideStart && insideStart.nodeType === 3) {
        // c → a：进入（内侧起点）
        e.preventDefault()
        setDomCaret(view, insideStart, 0, next.marks)
        placedSide = { pos, node: insideStart, offset: 0 }
        placedSideMarks = next.marks
      } else if (e.key === 'ArrowLeft' && isInside) {
        // a → c：跳出（左外侧）
        e.preventDefault()
        const at = view.domAtPos(pos, -1)
        setDomCaret(view, at.node, at.offset, prev ? prev.marks : [])
        placedSide = { pos, node: at.node, offset: at.offset }
        placedSideMarks = prev ? prev.marks : []
      }
    }
  }
  const readSel = (): void => {
    if (composingSide) return
    const view = getView()
    if (!view) return
    const state = view.state
    const sel = state.selection
    const domSel = window.getSelection()
    if (!domSel || domSel.rangeCount === 0) return

    // ① 落点守护：同位置的 PM 改写恢复到用户按键选定的侧
    if (placedSide) {
      if (!sel.empty || sel.from !== placedSide.pos) {
        placedSide = null
      } else if (
        (domSel.anchorNode !== placedSide.node || domSel.anchorOffset !== placedSide.offset) &&
        placedSide.node.isConnected
      ) {
        setDomCaret(view, placedSide.node, placedSide.offset, placedSideMarks)
        return
      } else {
        return // 落点未变：不做一般校正（侧已明确）
      }
    }

    // ② 一般校正（原生移动/点击到达边界）：DOM 侧与左偏置不一致时，
    //    以 DOM 侧设置 storedMarks。⚠️ 必须延迟执行：selectionchange 时
    //    PM 的状态同步在 ~20ms 后的异步 flush 里——同步读 state 拿到的
    //    还是旧位置（对着旧位置判边界永远不命中）
    if (!sel.empty) return
    window.setTimeout(() => generalCorrect(getView), 80)
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
  // 撤销/重做拦截（注册在 collab keymap 之前）：结构栈顶比 y-undo 最近
  // 捕获更晚时弹结构栈（y-undo 对块级/格式变换恢复错乱），否则放行 y-undo
  'Mod-z': (_state, _dispatch, view) => (view ? interceptUndo(view as never, docPath()) : false),
  'Mod-Shift-z': (_state, _dispatch, view) => (view ? interceptRedo(view as never, docPath()) : false),
  'Mod-y': (_state, _dispatch, view) => (view ? interceptRedo(view as never, docPath()) : false),
  // 加粗/斜体：Typora 式（光标在格式区内直接切换整段；无选区普通文本整行应用）
  'Mod-b': smartToggleMark('strong'),
  'Mod-i': smartToggleMark('emphasis'),
  // ⬅️ 选区坍缩：坍缩点为标记区起点时接管（光标进字面开定界符内侧，
  //  如 **|ABCDEF**），否则返回 false 放行浏览器原生坍缩/移动
  ArrowLeft: (_state, _dispatch, view) => (view ? collapseSelectionIntoMarkLeft(view as CascadeView) : false),
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
