/**
 * 结构变换撤销（自管栈 + 与 y-undo 按时间交错）：
 * y-undo（yjs UndoManager）对文本编辑撤销可靠，但对结构变换（段落↔标题、
 * mark 切换）的恢复错乱——实测 undo 会复活大量历史删除且不删新结构
 * （y-prosemirror 1.3.7 / yjs 13.6.33 均为最新，无可升级修复）。
 *
 * 方案：块级/格式命令的 dispatch 走 dispatchStructure——事务打
 * addToHistory:false（不进 y-undo 栈），前后文档快照压入本模块的
 * 结构栈；Mod-z/Mod-Shift-z 拦截（keymap 注册在 collab keymap 之前）：
 * undo 按时间戳与 y-undo 交错弹出；redo 优先重做最近 undo 的同一侧。
 */
import { Slice } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

interface StructureStep {
  /** 文档路径（跨文档栈项作废） */
  path: string
  /** 操作时刻（毫秒，与 um.lastChange 同基准——yjs getUnixTime 即 Date.now） */
  at: number
  /** 操作前/后文档快照（PM 节点不可变，直接引用） */
  before: PMNode
  after: PMNode
  /** 操作前选区（undo 后恢复） */
  anchor: number
  head: number
}

const undoStack: StructureStep[] = []
const redoStack: StructureStep[] = []
/** 最近一次 undo 实际处理的一侧（redo 优先同侧） */
let lastUndoSide: 'structure' | 'yjs' = 'yjs'

// 调试：暴露到 window 供浏览器控制台诊断（同 pm-view 模式）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__mfStructUndo = {
    undoStack,
    redoStack,
    get lastUndoSide() {
      return lastUndoSide
    },
  }
}

type View = {
  state: EditorState
  dispatch: (tr: Transaction) => void
}

/** y-undo 的 UndoManager（y-prosemirror 插件 key 为 y-undo$） */
function getUndoManager(state: EditorState): { lastChange?: number; undoStack?: unknown[] } | null {
  try {
    const plugin = state.plugins.find((p) => String((p as unknown as { key?: string }).key).includes('y-undo'))
    return (plugin?.getState(state)?.undoManager as { lastChange?: number; undoStack?: unknown[] }) ?? null
  } catch {
    return null
  }
}

/** 结构命令的 dispatch 包装：事务不进 y-undo 栈，快照入结构栈 */
export function dispatchStructure(view: View, path: string, tr: Transaction): void {
  tr.setMeta('addToHistory', false)
  const before = view.state.doc
  const { anchor, head } = view.state.selection
  view.dispatch(tr)
  const after = view.state.doc
  if (after === before) return
  undoStack.push({ path, at: Date.now(), before, after, anchor, head })
  redoStack.length = 0
}

/** 文档切换清栈（旧文档的快照对当前编辑器无意义） */
export function clearStructureUndo(): void {
  undoStack.length = 0
  redoStack.length = 0
}

/** 把当前文档整块替换为 target（yjs 层按 diff 同步远端），恢复选区 */
function restoreDoc(view: View, target: PMNode, anchor: number, head: number): void {
  const tr = view.state.tr.replace(0, view.state.doc.content.size, new Slice(target.content, 0, 0))
  tr.setMeta('addToHistory', false)
  try {
    tr.setSelection(
      TextSelection.create(tr.doc, Math.min(anchor, tr.doc.content.size), Math.min(head, tr.doc.content.size)),
    )
  } catch {
    /* 选区越界时保持默认 */
  }
  view.dispatch(tr)
}

function topOf(stack: StructureStep[], path: string): StructureStep | null {
  while (stack.length > 0 && stack[stack.length - 1]!.path !== path) stack.pop()
  return stack[stack.length - 1] ?? null
}

/** Mod-z 拦截：结构栈顶比 y-undo 最近捕获更晚 → 弹结构栈；否则放行 y-undo */
export function interceptUndo(view: View, path: string): boolean {
  const um = getUndoManager(view.state)
  const yAt = typeof um?.lastChange === 'number' ? um.lastChange : 0
  const top = topOf(undoStack, path)
  if (top && top.at >= yAt) {
    undoStack.pop()
    restoreDoc(view, top.before, top.anchor, top.head)
    redoStack.push(top)
    lastUndoSide = 'structure'
    return true
  }
  // 放行：y-undo 栈非空时本次 undo 将由 yjs 处理（redo 侧别抢占）
  if ((um?.undoStack?.length ?? 0) > 0) lastUndoSide = 'yjs'
  return false
}

/** Mod-Shift-z / Mod-y 拦截：最近 undo 的是结构侧才重做结构步骤 */
export function interceptRedo(view: View, path: string): boolean {
  if (lastUndoSide !== 'structure') return false
  const top = topOf(redoStack, path)
  if (!top) return false
  redoStack.pop()
  restoreDoc(view, top.after, top.anchor, top.head)
  undoStack.push(top)
  return true
}
