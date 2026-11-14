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
import { markSourceRevealKey, type Revealed } from './mark-source-reveal'
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
  /** after 时刻的源码展开元数据——恢复 after/before 时必须一并还原，
   *  否则展开态字面留在文档里又没有 revealed 供合拢判定，
   *  "加粗显示成源码"泄漏（用户实测 Cmd+Shift+Z 后固化） */
  revealedAfter: Revealed | null
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
    // 时间窗合并：保留组起点的 before 与选区（undo 恢复到"组输入前"的
    // 光标位置——曾被组内最新步覆盖，撤销后光标跳到输入后位置的回归源），
    // 只更新终点快照/时刻/展开元数据
    top.after = step.after
    top.at = step.at
    top.revealedAfter = step.revealedAfter
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
    init: (_init, state) => ({ lastDoc: state.doc, lastSel: state.selection }),
    apply(tr, prev, _oldState, newState) {
      const lastDoc = prev.lastDoc ?? newState.doc
      if (tr.docChanged && tr.getMeta('addToHistory') !== false && !tr.getMeta(ySyncPluginKey)) {
        if (lastDoc !== newState.doc) {
          // 恢复目标选区 = 本事务开始前的选区（上一事务结束时记录的值；
          // 直接读 tr.selectionBefore 在部分事务链上拿到的是事务后位置）
          const sel = prev.lastSel ?? newState.selection
          pushStep({
            path: currentPath(),
            at: Date.now(),
            before: lastDoc,
            after: newState.doc,
            anchor: sel.anchor,
            head: sel.head,
            structural: false,
            revealedAfter: readRevealed(newState),
          })
        }
      }
      return { lastDoc: newState.doc, lastSel: newState.selection }
    },
  },
})

/** 读当前 reveal 展开元数据（捕获点用；插件注册在 reveal 之后，读到级联后的最新值） */
function readRevealed(state: EditorState): Revealed | null {
  return (markSourceRevealKey.getState(state) as { revealed: Revealed | null } | undefined)?.revealed ?? null
}

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
    revealedAfter: readRevealed(view.state),
  })
  redoStack.length = 0
  prune()
}

/** 文档切换清栈（编辑器整体重挂载时调用；旧快照无意义） */
export function clearStructureUndo(): void {
  undoStack.length = 0
  redoStack.length = 0
}

/** 把当前文档整块替换为 target（yjs 层按 diff 同步远端），恢复选区；
 *  同时还原 reveal 展开元数据并触发合拢/保持判定——恢复的快照若处于
 *  展开态，光标在区内则保持、在区外则立即合拢回渲染态（字面自愈，
 *  否则"加粗显示成源码"永久泄漏进文档） */
function restoreDoc(
  view: View,
  target: PMNode,
  anchor: number,
  head: number,
  revealed: Revealed | null,
): void {
  // 元数据完好性预检：区间在恢复后的文档里必须是完好的字面形态（前后缀
  // 匹配）——不匹配（文档实际是渲染态等）一律置 null，杜绝元数据与文档
  // 形态不符引发的连锁变换与光标位移
  let revealedNow = revealed
  if (revealedNow) {
    const text = target.textBetween(revealedNow.from, revealedNow.to, '\n', ' ')
    const ok =
      text.length >= revealedNow.syntax.length * 2 &&
      text.startsWith(revealedNow.syntax) &&
      text.endsWith(revealedNow.syntax)
    if (!ok) revealedNow = null
  }
  const tr = view.state.tr.replace(0, view.state.doc.content.size, new Slice(target.content, 0, 0))
  tr.setMeta('addToHistory', false)
  tr.setMeta(markSourceRevealKey, { revealed: revealedNow })
  try {
    tr.setSelection(
      TextSelection.create(tr.doc, Math.min(anchor, tr.doc.content.size), Math.min(head, tr.doc.content.size)),
    )
  } catch {
    /* 选区越界时保持默认 */
  }
  view.dispatch(tr)
  // 触发 reveal 插件的离开判定（① 合拢分支）：restore tr 因自有 meta 被
  // anyOwn 短路，补一个同位置 selectionSet 事务驱动 appendTransaction。
  // 仅展开态需要（普通文本撤销 revealed=null，多余事务徒增选区边界效应）
  if (revealedNow) {
    const st = view.state
    const fire = st.tr.setSelection(TextSelection.create(st.doc, st.selection.from, st.selection.to))
    fire.setMeta('addToHistory', false)
    view.dispatch(fire)
  }
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
    // before 时刻的展开元数据 = 前一步的 revealedAfter（前一步 after 即本步 before）
    const prev = topOf(undoStack, path)
    restoreDoc(view, top.before, top.anchor, top.head, prev ? prev.revealedAfter : null)
    redoStack.push(top)
  }
  return true
}

/** Mod-Shift-z / Mod-y：快照栈重做 */
export function interceptRedo(view: View, path: string): boolean {
  const top = topOf(redoStack, path)
  if (top) {
    redoStack.pop()
    restoreDoc(view, top.after, top.anchor, top.head, top.revealedAfter)
    undoStack.push(top)
  }
  return true
}
