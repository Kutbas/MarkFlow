/**
 * 表格工具栏：光标进入表格时，在表格上方显示浮动工具栏。
 * 不用 PM widget decoration（会干扰表格渲染），改用 DOM 定位：
 * - 监听 selectionchange 检测光标是否在 table 内
 * - 用 table.getBoundingClientRect() 定位工具栏
 * - 工具栏是 document.body 的直接子元素（fixed 定位）
 */
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { getPMParser, getPMView } from './pm-view'

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
  dom: HTMLElement
}

interface PosLike {
  pos: number
  depth: number
  node: (d: number) => PMNode
  before: (d: number) => number
  after: (d: number) => number
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
  el.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation()
    onClick()
    // 插列/删行等操作后 selection 坐标可能不变，selectionchange 不会触发：
    // 主动刷新一次，重建按钮闭包与工具栏位置
    requestAnimationFrame(refreshToolbar)
  })
  return el
}

function sep(): HTMLElement {
  const s = document.createElement('span')
  s.className = 'mf-tb-sep'
  return s
}

// ============================================================
// PM 查找辅助
// ============================================================

export function findRow($from: PosLike): { node: PMNode; pos: number; depth: number } | null {
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table_row' || n.type.name === 'table_header_row') {
      return { node: n, pos: $from.before(d), depth: d }
    }
  }
  return null
}

export function findTable($from: PosLike): { node: PMNode; pos: number } | null {
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table') {
      return { node: n, pos: $from.before(d) }
    }
  }
  return null
}

export function colIndex($from: PosLike): number {
  const row = findRow($from)
  if (!row) return -1
  const target = $from.pos - row.pos - 1
  let ci = 0
  let found = false
  // forEach 无法中断：命中后用 found 标志冻结计数，否则后续 cell 会继续累加导致列号错乱
  row.node.forEach((cell, cellOffset) => {
    if (found) return
    if (target >= cellOffset && target < cellOffset + cell.nodeSize) found = true
    else ci++
  })
  return found ? ci : -1
}

// ============================================================
// 表格操作
// ============================================================

export function setColumnAlign(view: ViewLike, tablePos: number, table: PMNode, align: string | null): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const tr = view.state.tr
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        tr.setNodeMarkup(tablePos + 2 + rowOffset + cellOffset, undefined, { ...cell.attrs, alignment: align })
      }
      i++
    })
  })
  view.dispatch(tr)
  view.focus()
}

export function addRowBelow(view: ViewLike): void {
  const row = findRow(view.state.selection.$from)
  if (!row) return
  const schema = row.node.type.schema
  // 表头行（table_header_row）里是 table_header cell，table_row 只接受 table_cell——
  // 统一创建数据行（cell 用 table_cell），列数与当前行一致并继承列对齐
  const cellType = schema.nodes['table_cell']
  const rowType = schema.nodes['table_row']
  if (!cellType || !rowType) return
  const cells: PMNode[] = []
  row.node.forEach((cell) => {
    const c = cellType.createAndFill({ alignment: cell.attrs['alignment'] })
    if (c) cells.push(c)
  })
  const newRow = rowType.createAndFill(null, cells)
  if (newRow) {
    view.dispatch(view.state.tr.insert(row.pos + row.node.nodeSize, newRow))
    view.focus()
  }
}

export function deleteCurrentRow(view: ViewLike): void {
  const row = findRow(view.state.selection.$from)
  if (!row) return
  view.dispatch(view.state.tr.delete(row.pos, row.pos + row.node.nodeSize))
  view.focus()
}

export function addColRight(view: ViewLike, tablePos: number, table: PMNode): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const inserts: Array<[number, PMNode]> = []
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        const newCell = cell.type.createAndFill({ ...cell.attrs, alignment: null })
        if (newCell) {
          inserts.push([tablePos + 2 + rowOffset + cellOffset + cell.nodeSize, newCell])
        }
      }
      i++
    })
  })
  // 同一 tr 上多次 insert 后续位置会偏移：从大位置往小位置插，先插的不影响后插的
  inserts.reverse()
  let tr = view.state.tr
  for (const [pos, cell] of inserts) tr = tr.insert(pos, cell)
  view.dispatch(tr)
  view.focus()
}

export function deleteCurrentCol(view: ViewLike, tablePos: number, table: PMNode): void {
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return
  const dels: Array<[number, number]> = []
  table.forEach((row, rowOffset) => {
    let i = 0
    row.forEach((cell, cellOffset) => {
      if (i === ci) {
        dels.push([tablePos + 2 + rowOffset + cellOffset, tablePos + 2 + rowOffset + cellOffset + cell.nodeSize])
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

export function deleteWholeTable(view: ViewLike, tablePos: number, table: PMNode): void {
  view.dispatch(view.state.tr.delete(tablePos, tablePos + table.nodeSize))
  view.focus()
}

// ============================================================
// 源码编辑
// ============================================================

export function tableToMd(node: PMNode): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => {
      cells.push(cell.textContent.replace(/\|/g, '\\|'))
    })
    // 对齐只在表头行采集一次（列对齐语义；forEach 第二参是 offset 不是列号）
    if (aligns.length === 0) {
      row.forEach((cell) => aligns.push((cell.attrs['alignment'] as string | null) ?? null))
    }
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
  ok.addEventListener('click', () => {
    const md = ta.value.trim()
    if (!md) { close(); return }
    try {
      // 必须用编辑器同 schema 实例的 parser：异 schema 节点 replaceWith 后会被协同同步丢弃
      const parse = getPMParser() as ((markdown: string) => { firstChild: PMNode | null }) | null
      const newNode = parse ? parse(md).firstChild : null
      // nodeAt 取点击时刻的真实节点，防面板打开期间协同编辑变更
      const current = view.state.doc.nodeAt(pos)
      if (newNode && current && newNode.type.name === current.type.name) {
        view.dispatch(view.state.tr.replaceWith(pos, pos + current.nodeSize, newNode))
        view.focus()
      }
    } catch { /* 静默 */ }
    close()
  })
  ta.focus()
}

// ============================================================
// 浮动工具栏（DOM fixed 定位，不用 PM decoration）
// ============================================================

let currentToolbar: HTMLElement | null = null
/** 工具栏依附的表格元素：同一表格内的点击/选区变化只原地更新，不重建 */
let currentTableEl: HTMLElement | null = null
/** 对齐按钮引用（原地更新激活态用） */
let alignBtnEls: Array<{ el: HTMLElement; align: string }> = []
/** 工具栏顶相对表格顶的锚定偏移：首次定位后锁定，滚动时刚性平移——
 *  重读 offsetHeight 会因首帧后高度微变产生一次性跳变（抖动） */
let toolbarAnchor = 0

function hideToolbar(): void {
  currentToolbar?.remove()
  currentToolbar = null
  currentTableEl = null
  alignBtnEls = []
  toolbarAnchor = 0
}

function positionToolbar(bar: HTMLElement, tableEl: HTMLElement): void {
  const rect = tableEl.getBoundingClientRect()
  bar.style.position = 'fixed'
  // 水平居中于表格正上方：left=表格中线 + translateX(-50%)（布局保证居中，无读宽误差）
  bar.style.left = `${rect.left + rect.width / 2}px`
  bar.style.transform = 'translateX(-50%)'
  bar.style.zIndex = '500'
  // 表格贴近视口顶部时（rect.top - 高度 < 0）工具栏会盖住表格第一行：
  // 下沉到表格内部顶缘（Typora 同款行为），绝不遮挡编辑区上方的其他内容
  const below = rect.top - bar.offsetHeight - 4
  if (below < 8) {
    bar.style.top = `${rect.top + 4}px`
    bar.classList.add('mf-tb-overlay')
  } else {
    bar.style.top = `${below}px`
    bar.classList.remove('mf-tb-overlay')
  }
  toolbarAnchor = bar.getBoundingClientRect().top - rect.top
}

function showToolbar(tableEl: HTMLElement, view: ViewLike): void {
  hideToolbar()
  const bar = document.createElement('div')
  bar.className = 'mf-table-toolbar'

  // 按钮回调一律点击时实时解析表格——闭包捕获的快照在文档变化后
  // （插列等操作不触发 selectionchange）会整体错位
  const withTable = (fn: (tablePos: number, table: PMNode) => void) => () => {
    const t = findTable(view.state.selection.$from)
    if (t) fn(t.pos, t.node)
  }

  // 当前列对齐激活态：latex 等主题默认居中且列宽收缩到内容宽，对齐的视觉差异
  // 极小——必须用按钮高亮告诉用户当前列的对齐状态（null=无标注，全不亮）
  const currentAlign = columnAlignOf(view)

  const left = document.createElement('div')
  left.className = 'mf-tb-group'
  alignBtnEls = []
  const alignBtn = (icon: string, tip: string, align: string) => {
    const b = btn(icon, tip, withTable((p, n) => setColumnAlign(view, p, n, align)))
    if (currentAlign === align) b.classList.add('mf-tb-btn-active')
    alignBtnEls.push({ el: b, align })
    return b
  }
  left.appendChild(alignBtn('alignLeft', '左对齐', 'left'))
  left.appendChild(alignBtn('alignCenter', '居中对齐', 'center'))
  left.appendChild(alignBtn('alignRight', '右对齐', 'right'))
  left.appendChild(sep())
  left.appendChild(btn('addRow', '在下方插入行', () => addRowBelow(view)))
  left.appendChild(btn('deleteRow', '删除当前行', () => deleteCurrentRow(view)))
  left.appendChild(btn('addCol', '在右侧插入列', withTable((p, n) => addColRight(view, p, n))))
  left.appendChild(btn('deleteCol', '删除当前列', withTable((p, n) => deleteCurrentCol(view, p, n))))
  left.appendChild(sep())
  left.appendChild(btn('source', '查看源码', withTable((p, n) => openSourceEditor(n, view, p))))

  const right = document.createElement('div')
  right.className = 'mf-tb-group'
  right.appendChild(btn('deleteTable', '删除表格', withTable((p, n) => deleteWholeTable(view, p, n))))

  bar.appendChild(left)
  bar.appendChild(right)
  document.body.appendChild(bar)
  currentToolbar = bar
  currentTableEl = tableEl
  positionToolbar(bar, tableEl)
  // 点击后的选区装饰等会使表格微移（实测 ~8px）：布局稳定后校正一次
  requestAnimationFrame(() => {
    if (currentToolbar === bar) positionToolbar(bar, tableEl)
  })
}

/** 读取光标所在列的对齐（该列任一 cell 的 alignment，列内一致） */
function columnAlignOf(view: ViewLike): string | null {
  const row = findRow(view.state.selection.$from)
  if (!row) return null
  const ci = colIndex(view.state.selection.$from)
  if (ci < 0) return null
  let i = 0
  let align: string | null = null
  row.node.forEach((cell) => {
    if (i === ci) align = (cell.attrs['alignment'] as string | null) ?? null
    i++
  })
  return align
}

// ============================================================
// selectionchange 监听（光标进出表格 → 显示/隐藏工具栏）
// ============================================================

let initialized = false

/** 依据当前 selection 刷新工具栏（显示/隐藏/重定位）。文档变化但 selection 未变时
 *  （如刚插完列）selectionchange 不会触发，需要按钮回调主动调用。 */
function refreshToolbar(): void {
  const view = getPMView() as ViewLike | null
  if (!view?.state?.selection?.$from) {
    hideToolbar()
    return
  }

  const table = findTable(view.state.selection.$from)
  if (!table) {
    hideToolbar()
    return
  }

  // 找当前表格对应的 DOM
  const sel = window.getSelection()
  const selNode = sel?.anchorNode ?? null
  const anchorEl: HTMLElement | null = selNode
    ? selNode.nodeType === 1
      ? (selNode as HTMLElement)
      : selNode.parentElement
    : null
  const tableEl = anchorEl?.closest('table')
  if (!tableEl) {
    hideToolbar()
    return
  }

  // 同一表格内的点击/选区变化：只原地更新激活态，绝不重建（视觉极致稳定）
  if (currentToolbar && currentTableEl === tableEl) {
    const align = columnAlignOf(view)
    for (const { el, align: a } of alignBtnEls) {
      el.classList.toggle('mf-tb-btn-active', align === a)
    }
    return
  }

  showToolbar(tableEl, view)
}

export function initTableToolbar(): void {
  if (initialized) return
  initialized = true

  // 拖动选区期间 selectionchange 连发，逐次重建+重定位会让工具栏左右抽搐——
  // 拖动中冻结刷新（工具栏保持稳定），松开后统一刷新一次
  let dragging = false
  document.addEventListener(
    'mousedown',
    () => {
      dragging = true
    },
    true,
  )
  document.addEventListener(
    'mouseup',
    () => {
      if (!dragging) return
      dragging = false
      requestAnimationFrame(refreshToolbar)
    },
    true,
  )

  document.addEventListener('selectionchange', () => {
    if (dragging) return
    requestAnimationFrame(refreshToolbar)
  })

  // 滚动时更新位置：编辑区滚动发生在 .editor-scroll 容器（window scroll 不触发），
  // 两个都监听保证工具栏吸附表格。滚动用锚定偏移刚性平移（不重读高度），
  // 仅当表格逼近视口顶时走完整重定位（切换贴顶 overlay 态）
  const onScroll = () => {
    if (!currentToolbar) return
    const sel = window.getSelection()
    if (!sel?.anchorNode) return
    const node: HTMLElement | null = sel.anchorNode.nodeType === 1
      ? (sel.anchorNode as HTMLElement)
      : sel.anchorNode.parentElement
    const tableEl = node?.closest('table')
    if (!tableEl) return
    const rect = tableEl.getBoundingClientRect()
    const target = rect.top + toolbarAnchor
    if (target < 8) {
      positionToolbar(currentToolbar, tableEl)
    } else {
      currentToolbar.style.top = `${target}px`
      currentToolbar.classList.remove('mf-tb-overlay')
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  document.querySelector('.editor-scroll')?.addEventListener('scroll', onScroll, { passive: true })
}
