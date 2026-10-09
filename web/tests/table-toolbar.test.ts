import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import { Transform } from '@milkdown/kit/prose/transform'
import { getHeadless } from '@markflow/shared/headless'
import {
  addColRight,
  addRowBelow,
  colIndex,
  deleteCurrentCol,
  deleteCurrentRow,
  deleteWholeTable,
  setColumnAlign,
  tableToMd,
} from '../src/components/table-toolbar'
import { setPMParser } from '../src/components/pm-view'

const MD = [
  '| 功能 | 技术选型 | 状态 |',
  '| ---- | -------- | ---- |',
  '| 实时协同 | Yjs + Hocuspocus | ✅ |',
  '| 所见即所得 | Milkdown | ✅ |',
  '| PDF 导出 | Puppeteer | ✅ |',
].join('\n')

interface ViewLike {
  state: { doc: PMNode; tr: Transform; selection: { $from: ReturnType<PMNode['resolve']> } }
  dispatch: (tr: Transform) => void
  focus: () => void
  dom: HTMLElement
}

/** 构造最小 EditorView 替身：真实 doc + Transform，dispatch 后滚动 state */
function makeView(doc: PMNode, cursorText: string): ViewLike {
  let pos = -1
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && (node.text ?? '').startsWith(cursorText)) pos = p
    return pos < 0
  })
  if (pos < 0) throw new Error(`找不到文本: ${cursorText}`)
  const view = {
    state: {
      doc,
      tr: new Transform(doc),
      selection: TextSelection.create(doc, pos),
    },
    dispatch(tr: Transform) {
      const next = Math.min(pos, tr.doc.content.size)
      view.state = {
        doc: tr.doc as PMNode,
        tr: new Transform(tr.doc as PMNode),
        selection: TextSelection.create(tr.doc as PMNode, next),
      }
    },
    focus: () => {},
    dom: document.createElement('div'),
  } as ViewLike
  return view
}

function tableOf(doc: PMNode): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null
  doc.forEach((node, offset) => {
    if (!found && node.type.name === 'table') found = { node, pos: offset }
  })
  return found
}

function rowTexts(table: PMNode): string[] {
  const out: string[] = []
  table.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(cell.textContent || '·'))
    out.push(cells.join('|'))
  })
  return out
}

beforeAll(async () => {
  const { parse } = await getHeadless()
  // 源码编辑回填用同 schema parser（与生产里编辑器 parser 等价的角色）
  setPMParser(parse)
})

describe('table-toolbar 表格操作', () => {
  it('colIndex：光标在各列返回正确列号（forEach 命中后不再累加）', async () => {
    const { parse } = await getHeadless()
    for (const [text, want] of [
      ['实时协同', 0],
      ['Yjs + Hocuspocus', 1],
      ['✅', 2],
    ] as const) {
      const view = makeView(parse(MD), text)
      expect(colIndex(view.state.selection.$from)).toBe(want)
    }
  })

  it('setColumnAlign：只改当前列所有行的 alignment', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Yjs + Hocuspocus')
    const t = tableOf(view.state.doc)!
    setColumnAlign(view as never, t.pos, t.node, 'center')
    const table = tableOf(view.state.doc)!.node
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell) => cells.push(cell))
      cells.forEach((cell, i) => {
        // 无冒号分隔行解析出的 alignment 是 null（tableCellAlignNull 的默认值）
        expect(cell.attrs['alignment']).toBe(i === 1 ? 'center' : null)
      })
    })
  })

  it('addRowBelow：当前行下方插入等宽数据行，已有内容不动', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Yjs + Hocuspocus')
    addRowBelow(view as never)
    const table = tableOf(view.state.doc)!.node
    const texts = rowTexts(table)
    expect(texts).toHaveLength(5) // 表头 + 原3行 + 新1行（rowTexts 含表头行）
    expect(texts[0]).toBe('功能|技术选型|状态') // 表头
    expect(texts[1]).toBe('实时协同|Yjs + Hocuspocus|✅') // 当前行不动
    expect(texts[2]).toBe('·|·|·') // 新行插在当前行下方
    expect(texts[3]).toBe('所见即所得|Milkdown|✅')
    // 新行 cell 必须是 table_cell（非 table_header），schema 合法
    const dataRows: PMNode[] = []
    table.forEach((row) => { if (row.type.name === 'table_row') dataRows.push(row) })
    dataRows[0]!.forEach((cell) => expect(cell.type.name).toBe('table_cell'))
  })

  it('deleteCurrentRow：删除光标所在数据行', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Milkdown')
    deleteCurrentRow(view as never)
    const texts = rowTexts(tableOf(view.state.doc)!.node)
    expect(texts).toHaveLength(3)
    expect(texts.join('\n')).not.toContain('Milkdown')
  })

  it('addColRight：当前列右侧插入空列，已有文本不断裂', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Yjs + Hocuspocus')
    const t = tableOf(view.state.doc)!
    addColRight(view as never, t.pos, t.node)
    const table = tableOf(view.state.doc)!.node
    const texts = rowTexts(table)
    // 回归：旧实现同一 tr 顺序 insert 位置偏移，会把 "Milkdown"/"Puppeteer" 从中间切断
    expect(texts[0]).toBe('功能|技术选型|·|状态')
    expect(texts[1]).toBe('实时协同|Yjs + Hocuspocus|·|✅')
    expect(texts[2]).toBe('所见即所得|Milkdown|·|✅')
    expect(texts[3]).toBe('PDF 导出|Puppeteer|·|✅')
  })

  it('deleteCurrentCol：删除当前列，其余列内容完整保留', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Milkdown')
    const t = tableOf(view.state.doc)!
    deleteCurrentCol(view as never, t.pos, t.node)
    const texts = rowTexts(tableOf(view.state.doc)!.node)
    expect(texts[0]).toBe('功能|状态')
    expect(texts[1]).toBe('实时协同|✅')
    expect(texts[2]).toBe('所见即所得|✅')
    expect(texts[3]).toBe('PDF 导出|✅')
  })

  it('deleteWholeTable：表格整体移除', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Yjs + Hocuspocus')
    const t = tableOf(view.state.doc)!
    deleteWholeTable(view as never, t.pos, t.node)
    expect(tableOf(view.state.doc)).toBeNull()
  })

  it('tableToMd：分隔行列数与表头一致（只在表头采集对齐）', async () => {
    const { parse } = await getHeadless()
    const view = makeView(parse(MD), 'Yjs + Hocuspocus')
    const md = tableToMd(tableOf(view.state.doc)!.node)
    const lines = md.split('\n')
    expect(lines).toHaveLength(5)
    const headerCols = lines[0]!.split('|').filter(Boolean).length
    const sepCols = lines[1]!.split('|').filter((s) => s.trim()).length
    expect(sepCols).toBe(headerCols) // 回归：旧实现按 offset 累积对齐，4 行表格产出 9 列分隔
    expect(lines[1]).not.toContain(':--')
  })
})
