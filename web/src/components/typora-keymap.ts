import { Plugin } from '@milkdown/kit/prose/state'
import type { Mark } from '@milkdown/kit/prose/model'
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

/** 标记数组的集合相等比较（顺序无关） */
function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false
  const names = new Set(a.map((m) => m.type.name))
  return b.every((m) => names.has(m.type.name))
}

/**
 * 行内格式的"边界逃逸"（Typora 手感）：
 * PM 光标位置的 marks 是左偏置的——光标停在加粗（/代码/删除线）区域末端时，
 * 上下文仍是该标记：行尾按 ➡️ 无法跳出（后续输入全部加粗）；后跟普通文本时
 * 按 ➡️ 会一步跨过普通字符、按 ⬅️ 又被拉回加粗区（同一位置只有一种左偏置渲染）。
 * 修复：➡️ 在"标记区末端"先就地切换上下文到右侧字符（行尾=无标记）再消费按键；
 * ⬅️ 落到边界位置时以右侧字符的 marks 作为光标上下文（渲染在它前面）。
 */
/**
 * 方向键边界逃逸：纯 ArrowLeft/Right 在文本内部不经过 PM 的
 * handleKeyDown（浏览器原生移动光标，PM 事后同步），keymap 绑定永远不触发；
 * 且 milkdown 管线里 Plugin 的 view() 钩子不执行——须在 setPMView 后
 * 手动挂到 view.dom（捕获阶段，先于浏览器默认移动）。返回卸载函数。
 */
/**
 * 方向键边界逃逸：纯 ArrowLeft/Right 在文本内部不经过 PM 的
 * handleKeyDown（浏览器原生移动光标，PM 事后同步），keymap 绑定不触发；
 * 且编辑器会频繁重建（HMR/文档切换），监听器挂 document（捕获阶段）+
 * target 过滤最稳。返回卸载函数。
 */
export function attachArrowEscape(getView: () => { state: Parameters<Command>[0]; dispatch(tr: unknown): void; dom: HTMLElement } | null): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const target = e.target as HTMLElement | null
    if (!target || !target.closest('.ProseMirror')) return
    const view = getView()
    if (!view) return
    const dir = e.key === 'ArrowRight' ? 'right' : 'left'
    const handled = arrowEscapeMark(dir)(view.state, (tr) => view.dispatch(tr))
    // 左移是我们自行落位（dispatch setSelection），必须吞键防浏览器再移动一次；
    // 右移只切换格式上下文，移动交给浏览器原生——一次按键即视觉跳出
    if (handled && dir === 'left') e.preventDefault()
  }
  document.addEventListener('keydown', onKey, true)
  return () => document.removeEventListener('keydown', onKey, true)
}

export function arrowEscapeMark(dir: 'left' | 'right'): Command {
  return (state, dispatch) => {
    const { empty, $from } = state.selection
    if (!empty) return false

    if (dir === 'right') {
      const cur = state.storedMarks ?? $from.marks()
      if (cur.length === 0) return false
      const next = state.doc.nodeAt($from.pos)
      const prev = state.doc.nodeAt($from.pos - 1)
      if (!prev) return false // 块首：无"区域末端"可言
      const nextMarks: readonly Mark[] = next ? next.marks : []
      // 区域末端判定：当前上下文有右侧字符没有的标记，且左侧字符确实带这些标记
      const escaping = cur.filter(
        (m) => !nextMarks.some((n) => n.type === m.type) && prev.marks.some((n) => n.type === m.type),
      )
      if (escaping.length === 0) return false
      if (dispatch) {
        dispatch(state.tr.setStoredMarks(cur.filter((m) => !escaping.some((e) => e.type === m.type))))
      }
      return true
    }

    // 左移：自行落位到前一位置，上下文取右侧字符的 marks（渲染在其前面）
    const target = $from.pos - 1
    if (target < $from.start()) return false // 块首交给默认
    const $t = state.doc.resolve(target)
    if ($t.parent !== $from.parent) return false // 跨块交给默认
    const right = state.doc.nodeAt(target)
    const rightMarks: readonly Mark[] = right ? right.marks : []
    const sel = TextSelection.create(state.doc, target)
    if (!sameMarks(sel.$from.marks(), rightMarks)) {
      if (dispatch) {
        const tr = state.tr.setSelection(sel)
        tr.setStoredMarks(rightMarks as Mark[])
        dispatch(tr)
        return true
      }
    }
    return false // 上下文无差异：走默认左移
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

/** 任务列表切换：gfm 的任务是 list_item 的 checked 属性（null=普通项）——
 *  已是任务项 → 转回普通；普通列表项 → 转任务（默认未勾选）；
 *  不在列表 → 包一层无序列表并转为任务项 */
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

/**
 * 输入时刻的边界兜底：storedMarks（逃逸记忆）会被后续的光标同步事务清掉——
 * 光标停在标记区末端（左字符带标记、右侧无此标记或无字符）时输入文本，
 * 自动剥离这些"末端标记"：行尾直接打字就是普通文本（不再全行加粗）。
 * 光标在标记区中间（左右都有标记）不受影响，正常延续格式。
 */
export function markBoundaryInputPlugin(): Plugin {
  return new Plugin({
    props: {
      handleTextInput: (view, from, to, text) => {
        const state = (view as unknown as { state: Parameters<Command>[0] }).state
        const sel = state.selection
        if (!sel.empty || from !== sel.from) return false
        const $from = sel.$from
        const cur = state.storedMarks ?? $from.marks()
        if (cur.length === 0) return false
        const prev = state.doc.nodeAt($from.pos - 1)
        const next = state.doc.nodeAt($from.pos)
        if (!prev) return false
        const nextMarks: readonly Mark[] = next ? next.marks : []
        const escaping = cur.filter(
          (m) => !nextMarks.some((n) => n.type === m.type) && prev.marks.some((n) => n.type === m.type),
        )
        if (escaping.length === 0) return false
        const tr = state.tr
        // 先剥离逃逸标记再插入——插入时 storedMarks 即生效（顺序反了插入文本仍带标记）
        for (const m of escaping) {
          ;(tr as unknown as { removeStoredMark(mk: Mark): void }).removeStoredMark(m)
        }
        tr.insertText(text, from, to)
        ;(view as unknown as { dispatch(t: unknown): void }).dispatch(tr)
        return true
      },
    },
  })
}

export function typoraKeymapPlugin() {
  return [keymap(typoraShortcuts), markBoundaryInputPlugin()]
}
