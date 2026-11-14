/** 快照撤销栈（全接管）：结构/文本命令的 Cmd+Z 撤回、时间窗合并、远端隔离、展开态自愈 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { typoraShortcuts } from '../src/components/typora-keymap'
import { clearStructureUndo, snapshotCapturePlugin, interceptUndo, interceptRedo } from '../src/components/structure-undo'
import { markSourceRevealPlugin } from '../src/components/mark-source-reveal'

/** 可变 state 的 view 替身（结构栈的 dispatch/undo 都经它） */
function makeView(doc: PMNode, from = 1, to?: number) {
  let state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, from, to ?? from),
  })
  const view = {
    get state() {
      return state
    },
    dispatch(tr: Parameters<EditorState['apply']>[0]) {
      state = state.apply(tr)
    },
  }
  return view
}

function key(view: ReturnType<typeof makeView>, k: string): boolean {
  const cmd = typoraShortcuts[k]!
  return cmd(view.state as never, view.dispatch as never, view as never)
}

let parse: (md: string) => PMNode

beforeAll(async () => {
  parse = (await getHeadless()).parse
})

describe('结构撤销栈（y-undo 对结构变换恢复错乱的自管替代）', () => {
  it('Mod-1 转标题 → Mod-z 撤回段落（用户报告场景）→ Mod-Shift-z 重做标题', () => {
    clearStructureUndo()
    const view = makeView(parse('正文段落。\n'), 3)
    expect(key(view, 'Mod-1')).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('heading')
    expect(key(view, 'Mod-z')).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.state.doc.textContent).toContain('正文段落')
    expect(key(view, 'Mod-Shift-z')).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('heading')
  })

  it('加粗（Mod-b 词级）→ Mod-z 撤销加粗', () => {
    clearStructureUndo()
    const view = makeView(parse('hello world\n'), 3)
    expect(key(view, 'Mod-b')).toBe(true)
    let strong = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strong')) strong = true
    })
    expect(strong).toBe(true)
    expect(key(view, 'Mod-z')).toBe(true)
    strong = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strong')) strong = true
    })
    expect(strong).toBe(false)
  })

  it('结构变换事务带 addToHistory:false（不进 y-undo 栈）', () => {
    clearStructureUndo()
    const seen: Array<boolean | undefined> = []
    const doc = parse('正文段落。\n')
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) })
    const view = {
      get state() {
        return state
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        seen.push(tr.getMeta('addToHistory'))
        state = state.apply(tr)
      },
    }
    key(view, 'Mod-1')
    expect(seen).toEqual([false])
  })

  it('结构栈空时 Mod-z 吞掉按键（防空栈时浏览器原生 DOM undo 介入）', () => {
    clearStructureUndo()
    const view = makeView(parse('正文。\n'), 2)
    expect(key(view, 'Mod-z')).toBe(true)
    expect(view.state.doc.textContent).toContain('正文')
  })

  it('文本编辑经快照捕获插件入栈 → Mod-z 撤销', () => {
    clearStructureUndo()
    const doc = parse('hello\n')
    let state = EditorState.create({ doc, plugins: [snapshotCapturePlugin as never], selection: TextSelection.create(doc, 6) })
    const view = {
      get state() {
        return state
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        state = state.apply(tr)
      },
    }
    state = state.apply(state.tr.insertText(' world', 6))
    expect(state.doc.textContent).toBe('hello world')
    // 插件已捕获文本步 → Mod-z 撤销输入
    expect(key(view, 'Mod-z')).toBe(true)
    expect(view.state.doc.textContent).toBe('hello')
  })

  it('远端变更（带 ySync meta）不入快照栈', async () => {
    clearStructureUndo()
    const { ySyncPluginKey } = await import('y-prosemirror')
    const doc = parse('hello\n')
    let state = EditorState.create({ doc, plugins: [snapshotCapturePlugin as never], selection: TextSelection.create(doc, 6) })
    const tr = state.tr.insertText('X', 6)
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true })
    state = state.apply(tr)
    expect(state.doc.textContent).toBe('helloX')
    // 远端步不捕获 → Mod-z 吞掉但文档不变
    const view = {
      get state() {
        return state
      },
      dispatch(t: Parameters<EditorState['apply']>[0]) {
        state = state.apply(t)
      },
    }
    expect(key(view, 'Mod-z')).toBe(true)
    expect(view.state.doc.textContent).toBe('helloX')
  })

  it('800ms 时间窗内的连续文本编辑合并为一步，anchor 保留组输入前位置（撤销光标回位）', () => {
    clearStructureUndo()
    const doc = parse('\n')
    let state = EditorState.create({ doc, plugins: [snapshotCapturePlugin as never], selection: TextSelection.create(doc, 1) })
    const push = (text: string) => {
      const tr = state.tr.insertText(text, state.selection.from)
      state = state.apply(tr)
    }
    push('a')
    push('b')
    push('c')
    const su = (window as unknown as { __mfStructUndo: { undoStack: Array<{ before: PMNode; after: PMNode; anchor: number; head: number }> } }).__mfStructUndo
    expect(su.undoStack).toHaveLength(1) // 同窗合并
    expect(su.undoStack[0]!.before.textContent).toBe('') // 组起点
    expect(su.undoStack[0]!.after.textContent).toBe('abc')
    // 撤销应恢复"组输入前"的选区（首个字符输入前的位置），不随组内每步漂移
    expect(su.undoStack[0]!.anchor).toBe(1)
    expect(su.undoStack[0]!.head).toBe(1)
    // 实际撤销：光标回到 1
    const view = {
      get state() {
        return state
      },
      dispatch(t: Parameters<EditorState['apply']>[0]) {
        state = state.apply(t)
      },
    }
    expect(interceptUndo(view as never, '')).toBe(true)
    expect(state.doc.textContent).toBe('')
    expect(state.selection.from).toBe(1)
  })

  it('展开态快照经 redo 恢复后自动合拢（字面不泄漏进持久文档）', async () => {
    clearStructureUndo()
    // 加粗（结构步）→ reveal 级联展开字面 → undo → redo
    const doc = parse('XXX ABCDEF YYY\n')
    let state = EditorState.create({
      doc,
      plugins: [markSourceRevealPlugin as never, snapshotCapturePlugin as never],
      selection: TextSelection.create(doc, 5),
    })
    const view = {
      get state() {
        return state
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        state = state.apply(tr)
      },
    }
    // 光标 c 位：先触发 reveal 展开（模拟用户光标已进入），再加粗（revealedToggle 在展开态操作元数据）
    // 简化直击泄漏场景：直接用 smartToggleMark 词级加粗（光标在普通词内 → 加粗+级联展开）
    const ok = typoraShortcuts['Mod-b']!(view.state as never, view.dispatch as never, view as never)
    expect(ok).toBe(true)
    expect(state.doc.textContent).toContain('**ABCDEF**') // 展开态快照（after 即字面）
    // undo：回 before（渲染前普通文本）
    expect(interceptUndo(view as never, '')).toBe(true)
    expect(state.doc.textContent).toBe('XXX ABCDEF YYY')
    // redo：恢复 after（字面展开态）+ revealed 还原 → 光标在区内保持展开
    expect(interceptRedo(view as never, '')).toBe(true)
    expect(state.doc.textContent).toContain('**ABCDEF**')
    // 光标移出（区外）→ reveal 合拢 → 字面回渲染态 strong（自愈不泄漏）
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1)))
    expect(state.doc.textContent).toBe('XXX ABCDEF YYY')
    let strong = false
    state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strong')) strong = true
    })
    expect(strong).toBe(true)
  })
})
