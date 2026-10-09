import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { taskClickToggle } from '../src/components/task-click'

const MD = '* [ ] 未勾选任务\n* [x] 已勾选任务\n'

function makeView(doc: PMNode) {
  const view = {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 1) }),
    dispatch(tr: Parameters<EditorState['apply']>[0]) {
      view.state = view.state.apply(tr)
    },
    focus: () => {},
    dom: document.createElement('div'),
    posAtDOM(dom: Node) {
      // 测试替身：从 doc 里找该 li 对应的 list_item 内容起点（第 1 个=2，第 2 个按节点大小推）
      const idx = (dom as unknown as { __idx: number }).__idx
      let pos = 0
      doc.forEach((n, off) => {
        if (n.type.name === 'bullet_list') {
          let i = 0
          n.forEach((item, itemOff) => {
            if (i === idx) pos = off + 1 + itemOff + 1
            i++
          })
        }
      })
      return pos
    },
  }
  return view
}

function fakeLi(idx: number, liLeft: number) {
  const el = document.createElement('li')
  el.setAttribute('data-item-type', 'task')
  ;(el as unknown as { __idx: number }).__idx = idx
  el.getBoundingClientRect = () => ({ left: liLeft, right: liLeft + 300, top: 0, bottom: 20, width: 300, height: 20, x: liLeft, y: 0, toJSON: () => ({}) }) as DOMRect
  el.closest = () => el
  return el
}

function clickEvent(target: HTMLElement, clientX: number) {
  return { target, clientX, clientY: 10 } as unknown as MouseEvent
}

let parsed: PMNode
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let handler: any

beforeAll(async () => {
  const { parse } = await getHeadless()
  parsed = parse(MD)
  handler = taskClickToggle.props?.handleClick
})

function checkedOf(doc: PMNode): (boolean | null)[] {
  const out: (boolean | null)[] = []
  doc.forEach((list) => {
    if (list.type.name === 'bullet_list') {
      list.forEach((item) => out.push((item.attrs['checked'] as boolean | null) ?? null))
    }
  })
  return out
}

describe('task-click 点击切换', () => {
  it('点击勾选框区域：未勾选 → 已勾选', () => {
    const view = makeView(parsed)
    const li = fakeLi(0, 100) // li 内容盒左边界 x=100
    // 点击 x=90（勾选框悬挂区，距左界 10px < boxWidth≈22）
    expect(handler!(view as never, 0, clickEvent(li, 90) as never, view as never)).toBe(true)
    expect(checkedOf(view.state.doc)[0]).toBe(true)
  })

  it('再次点击：取消勾选', () => {
    const view = makeView(parsed)
    const li = fakeLi(0, 100)
    handler!(view as never, 0, clickEvent(li, 90) as never, view as never)
    expect(handler!(view as never, 0, clickEvent(li, 95) as never, view as never)).toBe(true)
    expect(checkedOf(view.state.doc)[0]).toBe(false)
  })

  it('点击文字区不切换；勾选框区域外的更左方不切换', () => {
    const view = makeView(parsed)
    const li = fakeLi(0, 100)
    // 文字区（li 内容盒内）
    expect(handler!(view as never, 0, clickEvent(li, 180) as never, view as never)).toBe(false)
    // 悬挂区更左（超出 boxWidth）
    expect(handler!(view as never, 0, clickEvent(li, 60) as never, view as never)).toBe(false)
    expect(checkedOf(view.state.doc)[0]).toBe(false)
  })

  it('点击的是第二项时只切换第二项', () => {
    const view = makeView(parsed)
    const li = fakeLi(1, 100)
    expect(handler!(view as never, 0, clickEvent(li, 90) as never, view as never)).toBe(true)
    const states = checkedOf(view.state.doc)
    expect(states[0]).toBe(false) // 第一项不动
    expect(states[1]).toBe(false) // 第二项 x→未勾选
  })
})
