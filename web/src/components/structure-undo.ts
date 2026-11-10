/**
 * 快照撤销栈（全接管：文本 + 结构统一自管）：
 * y-undo（yjs UndoManager）对结构变换恢复错乱（实测 undo 事务空转/复活
 * 历史删除），且其栈行为（stopCapturing 拆组、栈深不可控）在插件生态下
 * 不确定——彻底停用其捕获（captureTransaction 恒 false），撤销/重做
 * 全部走本模块的快照栈：
 *
 * - 文本编辑：snapshotCapturePlugin 监听本地真实事务（docChanged、
 *   addToHistory !== false、非远端 ySync 变更）→ 前后文档快照入栈，
 *   800ms 时间窗内合并为一步（同 PM history newGroupDelay 手感）
 * - 结构命令：dispatchStructure 压"强制新步"（tr 带 addToHistory:false
 *   天然不入文本捕获，与文本栈互不重复）
 * - 恢复 = 整文档 Slice 替换（yjs 层 diff 同步远端）+ 选区还原
 * - 上限：保留最近 200 步且 10 分钟内（超龄栈底惰性丢弃）
 */
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Slice } from '@milkdown/kit/prose/model'
import { ySyncPluginKey } from 'y-prosemirror'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'

/** 同一步合并窗口（毫秒）——连续快速打字并成一步，手感同常规编辑器 */
export const GROUP_MS = 800
/** 栈上限：步数 × 时限（撤不到更早的编辑） */
export const MAX_STEPS = 200
export const MAX_AGE_MS = 10 * 60 * 1000

interface UndoStep {
  /** 文档路径（跨文档栈项作废） */
  path: string
  /** 操作时刻（毫秒） */
  at: number
  /** 操作前/后文档快照（PM 节点不可变，结构共享，引用廉价） */
  before: PMNode
  after: PMNode
  /** 操作前选区（undo 后恢复） */
  anchor: number
  head: number
  /** 结构命令步：不参与时间窗合并（每次命令一个独立撤销单元） */
  structural: boolean
}

const undoStack: UndoStep[] = []
const redoStack: UndoStep[] = []

// 调试：暴露到 window 供浏览器控制台诊断（同 pm-view 模式）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__mfStructUndo = { undoStack, redoStack }
}

type View = {
  state: EditorState
  dispatch: (tr: Transaction) => void
}

function currentPath(): string {
  // 循环依赖规避：延迟 require 不可用（ESM）——由调用方传入 path；
  // 插件捕获处由 docPathFor() 注入（typora-keymap 提供，见下）
  return capturedPath()
}

/** 捕获用路径取值器（typora-keymap 初始化时注入，避免与 store 循环依赖） */
let capturedPath: () => string = () => ''
export function setUndoPathProvider(fn: () => string): void {
  capturedPath = fn
}

function prune(): void {
  const cutoff = Date.now() - MAX_AGE_MS
  while (undoStack.length > MAX_STEPS || (undoStack.length > 0 && undoStack[0]!.at < cutoff)) undoStack.shift()
}

function pushStep(step: UndoStep): void {
  const top = undoStack[undoStack.length - 1]
  if (
    top &&
    !top.structural &&
    !step.structural &&
    step.path === top.path &&
    step.at - top.at < GROUP_MS
  ) {
    // 时间窗合并：保留组起点的 before，更新终点快照与时刻
    top.after = step.after
    top.at = step.at
    top.anchor = step.anchor
    top.head = step.head
  } else {
    undoStack.push(step)
  }
  redoStack.length = 0
  prune()
}

/** 文本编辑捕获：本地真实事务（非视图态/非结构命令/非远端）快照入栈 */
export const snapshotCaptureKey = new PluginKey('mfSnapshotCapture')

export const snapshotCapturePlugin = new Plugin({
  key: snapshotCaptureKey,
  state: {
    init: (_init, state): { lastDoc: PMNode } => ({ lastDoc: state.doc }),
    apply(tr, prev, _oldState, newState) {
      const lastDoc = prev.lastDoc ?? newState.doc
      if (tr.docChanged && tr.getMeta('addToHistory') !== false && !tr.getMeta(ySyncPluginKey)) {
        if (lastDoc !== newState.doc) {
          const sel = (tr as unknown as { selectionBefore?: { anchor: number; head: number } }).selectionBefore
          pushStep({
            path: currentPath(),
            at: Date.now(),
            before: lastDoc,
            after: newState.doc,
            anchor: sel?.anchor ?? newState.selection.from,
            head: sel?.head ?? newState.selection.to,
            structural: false,
          })
        }
      }
      return { lastDoc: newState.doc }
    },
  },
})

/** 结构命令的 dispatch 包装：事务不进文本捕获，压独立结构步 */
export function dispatchStructure(view: View, path: string, tr: Transaction): void {
  tr.setMeta('addToHistory', false)
  const before = view.state.doc
  const { anchor, head } = view.state.selection
  view.dispatch(tr)
  const after = view.state.doc
  if (after === before) return
  undoStack.push({
    path,
    at: Date.now(),
    before,
    after,
    anchor,
    head,
    structural: true,
  })
  redoStack.length = 0
  prune()
}

/** 文档切换清栈（编辑器整体重挂载时调用；旧快照无意义） */
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

function topOf(stack: UndoStep[], path: string): UndoStep | null {
  while (stack.length > 0 && stack[stack.length - 1]!.path !== path) stack.pop()
  return stack[stack.length - 1] ?? null
}

/** Mod-z：快照栈是唯一撤销源（y-undo 捕获已停用）；栈空也吞掉按键
 *  （防空栈时浏览器原生 DOM undo 介入产生脱轨恢复） */
export function interceptUndo(view: View, path: string): boolean {
  prune()
  const top = topOf(undoStack, path)
  if (top) {
    undoStack.pop()
    restoreDoc(view, top.before, top.anchor, top.head)
    redoStack.push(top)
  }
  return true
}

/** Mod-Shift-z / Mod-y：快照栈重做 */
export function interceptRedo(view: View, path: string): boolean {
  const top = topOf(redoStack, path)
  if (top) {
    redoStack.pop()
    restoreDoc(view, top.after, top.anchor, top.head)
    undoStack.push(top)
  }
  return true
}
