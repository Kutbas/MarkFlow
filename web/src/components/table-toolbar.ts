/**
 * 表格工具栏：光标进入表格时显示（Typora 风格）。
 * 左上：对齐（左/中/右）+ 行列操作（插行/删行/插列/删列）+ 源码
 * 右上：删除表格
 * 全部 SVG 图标 + hover 显示文字提示。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

// ============================================================
// 类型
// ============================================================

interface TrLike {
  setNodeMarkup: (pos: number, type: unknown, attrs: unknown) => TrLike
  delete: (from: number, to: number) => TrLike
  insert: (pos: number, content: unknown) => TrLike
  replaceWith: (from: number, to: number, content: unknown) => TrLike
}

interface ViewLike {
  dispatch: (tr: unknown) => void
  state: {
    doc: PMNode
    tr: TrLike
    selection: { $from: PosLike }
  }
  focus: () => void
}

interface PosLike {
  pos: number
  depth: number
  node: (d: number) => PMNode
  before: (d: number) => number
  after: (d: number) => number
  parent: PMNode
}

function getView(): ViewLike | null {
  const el = document.querySelector('.ProseMirror') as HTMLElement & {
    pmViewDesc?: { view: ViewLike }
  }
  return el?.pmViewDesc?.view ?? null
}

// ============================================================
// SVG 图标
// ============================================================

const ICONS: Record<string, string> = {
  alignLeft: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>`,
  alignCenter: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>`,
  alignRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg>`,
  addRow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="12" y1="13" x2="12" y2="17"/><line x1="10" y1="15" x2="14" y2="15"/></svg>`,
  deleteRow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="13.5" x2="21" y2="13.5" stroke-dasharray="2 2"/></svg>`,
  addCol: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="9" y1="4" x2="9" y2="18"/><line x1="13" y1="9" x2="17" y2="9"/><line x1="15" y1="7" x2="15" y2="11"/></svg>`,
  deleteCol: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="13.5" y1="4" x2="13.5" y2="18"/><line x1="8.5" y1="4" x2="8.5" y2="18" stroke-dasharray="2 2"/></svg>`,
  deleteTable: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="18"/><line x1="15" y1="9" x2="15" y2="18"/><line x1="2" y1="22" x2="22" y2="22"/></svg>`,
  source: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
}

function btn(icon: string, tooltip: string, onClick: () => void): HTMLElement {
  const el = document.createElement('button')
  el.className = 'mf-tb-btn'
  el.innerHTML = ICONS[icon] ?? icon
  el.setAttribute('data-tooltip', tooltip)
  el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
  return el
}

function sep(): HTMLElement {
  const s = document.createElement('span')
  s.className = 'mf-tb-sep'
  return s
}

// ============================================================
// 表格操作
// ============================================================

function findRow($from: PosLike): { node: PMNode; pos: number; depth: number } | null {
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table_row' || n.type.name === 'table_header_row') {
      return { node: n, pos: $from.before(d), depth: d }
    }
  }
  return null
}

function colIndex($from: PosLike): number {
  const row = findRow($from)
  if (!row) return -1
  const rowStart = $from.after(row.depth) - row.node.nodeSize
  const offset = $from.pos - rowStart
  let ci = 0
  row.node.forEach((cell, cellOffset) => {
    if (offset >= cellOffset && offset < cellOffset + cell.nodeSize) return
    ci++
  })
  return ci
}

function setColumnAlign(view: ViewLike, tablePos: number, table: PMNode, align: string | null): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const tr = view.state.tr
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        tr.setNodeMarkup(tablePos + 1 + rowOffset + cellOffset, undefined, { ...cell.attrs, alignment: align })
      }
      i++
    })
  })
  view.dispatch(tr)
  view.focus()
}

function addRowBelow(view: ViewLike): void {
  const row = findRow(view.state.selection.$from)
  if (!row) return
  const cells: PMNode[] = []
  row.node.forEach((cell) => {
    const c = cell.type.createAndFill(cell.attrs)
    if (c) cells.push(c)
  })
  // 用 table_row 类型（不是 header row）
  const tableRowType = row.node.type.name === 'table_header_row'
    ? row.node.type.schema.nodes['table_row']
    : row.node.type
  const newRow = tableRowType?.createAndFill(null, cells)
  if (newRow) {
    view.dispatch(view.state.tr.insert(row.pos + row.node.nodeSize, newRow))
    view.focus()
  }
}

function deleteCurrentRow(view: ViewLike): void {
  const row = findRow(view.state.selection.$from)
  if (!row) return
  view.dispatch(view.state.tr.delete(row.pos, row.pos + row.node.nodeSize))
  view.focus()
}

function addColRight(view: ViewLike, tablePos: number, table: PMNode): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const tr = view.state.tr
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        const newCell = cell.type.createAndFill({ ...cell.attrs, alignment: null })
        if (newCell) {
          tr.insert(tablePos + 1 + rowOffset + cellOffset + cell.nodeSize, newCell)
        }
      }
      i++
    })
  })
  view.dispatch(tr)
  view.focus()
}

function deleteCurrentCol(view: ViewLike, tablePos: number, table: PMNode): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const dels: Array<[number, number]> = []
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        dels.push([tablePos + 1 + rowOffset + cellOffset, tablePos + 1 + rowOffset + cellOffset + cell.nodeSize])
      }
      i++
    })
  })
  dels.reverse()
  let tr = view.state.tr
  for (const [f, t] of dels) tr = tr.delete(f, t)
  view.dispatch(tr)
  view.focus()
}

function deleteTable(view: ViewLike, tablePos: number, table: PMNode): void {
  view.dispatch(view.state.tr.delete(tablePos, tablePos + table.nodeSize))
}

// ============================================================
// 源码编辑
// ============================================================

function tableToMd(node: PMNode): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell, i) => {
      cells.push(cell.textContent.replace(/\|/g, '\\|'))
      if (aligns.length <= i) aligns.push((cell.attrs['alignment'] as string | null) ?? null)
    })
    rows.push(cells)
  })
  if (rows.length === 0) return ''
  const lines: string[] = []
  lines.push('| ' + rows[0]!.join(' | ') + ' |')
  lines.push('| ' + aligns.map((a) => (a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---')).join(' | ') + ' |')
  for (let i = 1; i < rows.length; i++) lines.push('| ' + rows[i]!.join(' | ') + ' |')
  return lines.join('\n')
}

function openSourceEditor(node: PMNode, view: ViewLike, pos: number): void {
  const overlay = document.createElement('div')
  overlay.className = 'mf-table-editor-overlay'
  const panel = document.createElement('div')
  panel.className = 'mf-table-editor-panel'
  const ta = document.createElement('textarea')
  ta.className = 'mf-table-editor-textarea'
  ta.value = tableToMd(node)
  ta.rows = Math.max(4, (ta.value.match(/\n/g) ?? []).length + 2)
  const btns = document.createElement('div')
  btns.className = 'mf-table-editor-btns'
  const ok = document.createElement('button')
  ok.textContent = '应用'
  ok.className = 'mf-table-editor-ok'
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  cancel.className = 'mf-table-editor-cancel'
  btns.appendChild(ok)
  btns.appendChild(cancel)
  panel.appendChild(ta)
  panel.appendChild(btns)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  cancel.addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close() })
  ok.addEventListener('click', async () => {
    const md = ta.value.trim()
    if (!md) { close(); return }
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    try {
      const newNode = parse(md)
      if (newNode.type.name === node.type.name) {
        view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, newNode.content))
      }
    } catch { /* 静默 */ }
    close()
  })
  ta.focus()
}

// ============================================================
// 工具栏构建 + 插件
// ============================================================

function buildToolbar(tablePos: number, table: PMNode): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'mf-table-toolbar'

  const left = document.createElement('div')
  left.className = 'mf-tb-group'
  left.appendChild(btn('alignLeft', '左对齐', () => { const v = getView(); if (v) setColumnAlign(v, tablePos, table, 'left') }))
  left.appendChild(btn('alignCenter', '居中对齐', () => { const v = getView(); if (v) setColumnAlign(v, tablePos, table, 'center') }))
  left.appendChild(btn('alignRight', '右对齐', () => { const v = getView(); if (v) setColumnAlign(v, tablePos, table, 'right') }))
  left.appendChild(sep())
  left.appendChild(btn('addRow', '在下方插入行', () => { const v = getView(); if (v) addRowBelow(v) }))
  left.appendChild(btn('deleteRow', '删除当前行', () => { const v = getView(); if (v) deleteCurrentRow(v) }))
  left.appendChild(btn('addCol', '在右侧插入列', () => { const v = getView(); if (v) addColRight(v, tablePos, table) }))
  left.appendChild(btn('deleteCol', '删除当前列', () => { const v = getView(); if (v) deleteCurrentCol(v, tablePos, table) }))
  left.appendChild(sep())
  left.appendChild(btn('source', '查看源码', () => { const v = getView(); if (v) openSourceEditor(table, v, tablePos) }))

  const right = document.createElement('div')
  right.className = 'mf-tb-group'
  right.appendChild(btn('deleteTable', '删除表格', () => { const v = getView(); if (v) deleteTable(v, tablePos, table) }))

  bar.appendChild(left)
  bar.appendChild(right)
  return bar
}

function findTableAt(selection: { $from: PosLike }): { node: PMNode; pos: number } | null {
  for (let d = selection.$from.depth; d >= 0; d--) {
    const n = selection.$from.node(d)
    if (n.type.name === 'table') {
      return { node: n, pos: selection.$from.before(d) }
    }
  }
  return null
}

export const tableToolbarPlugin = new Plugin({
  key: new PluginKey('mfTableToolbar'),
  state: {
    init: () => ({ decorations: DecorationSet.empty }),
    apply: (_tr, _prev, _old, newState) => {
      const table = findTableAt(newState.selection as unknown as { $from: PosLike })
      if (!table) return { decorations: DecorationSet.empty }

      const deco = Decoration.widget(
        table.pos,
        () => buildToolbar(table.pos, table.node),
        { side: -1, key: `table-toolbar-${table.pos}`, ignoreSelection: true },
      )
      return { decorations: DecorationSet.create(newState.doc, [deco]) }
    },
  },
  props: {
    decorations(state) {
      return this.getState(state)?.decorations ?? null
    },
  },
})
