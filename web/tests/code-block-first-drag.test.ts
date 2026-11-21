/** 代码块视图交互：fences 常驻编辑态（round-123）+ mermaid 点击切换 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { createToggleView } from '../src/components/views'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
  // jsdom 的 rAF 在非视觉模式不触发：无条件换成定时器实现（placeCaret 双帧调度需要）
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
})

/** 组装 toggle-view + stub view，返回可交互的 DOM 与断言探针 */
function makeToggle(node: PMNode, asFences: boolean) {
  const state = EditorState.create({ doc: h.parse('# t\n\npara\n') })
  const dispatches: number[] = []
  const domObserver = { stopped: 0, started: 0, stop() { this.stopped++ }, start() { this.started++ } }
  const view = {
    state,
    dispatch: () => dispatches.push(1),
    focus: () => {},
    posAtCoords: () => null as { pos: number } | null,
    domObserver,
  }
  const nv = createToggleView({
    className: 'mf-code',
    render: () => {},
    clickToEdit: true,
    sourceAsFences: () => asFences,
  })(node, view as never, () => 1)
  const dom = nv.dom as HTMLElement
  const renderEl = dom.querySelector('.mf-render') as HTMLElement
  const fire = (type: string, el: HTMLElement = renderEl) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  return { dom, renderEl, fire, dispatches, domObserver }
}

describe('fences 常驻编辑态（round-123：选区永居 contentDOM）', () => {
  it('创建即含 editing 类——渲染层为 pointer-events:none 叠层，点击/拖选原生落在 contentDOM', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom } = makeToggle(node, true)
    expect(dom.classList.contains('editing')).toBe(true)
  })

  it('常驻态下 renderEl 上的 mousedown/mouseenter 全部无效（不拦截、不翻转、不触碰 PM 观察器）', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom, renderEl, fire, domObserver } = makeToggle(node, true)
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    renderEl.dispatchEvent(md)
    expect(md.defaultPrevented).toBe(false)
    fire('mouseenter')
    expect(dom.classList.contains('editing')).toBe(true) // 无翻转（恒在）
    expect(domObserver.stopped).toBe(0) // 不挂起 PM 观察
    expect(domObserver.started).toBe(0)
    // mouseup 转换监听不应存在：派发 document mouseup 无任何派发
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(domObserver.started).toBe(0)
  })

  it('selectionchange 上 leave/enter 对常驻 fences 均为 no-op（类恒在）', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom } = makeToggle(node, true)
    const collapsed = { rangeCount: 1, isCollapsed: true, anchorNode: document.body, focusNode: document.body }
    const spy = vi.spyOn(document, 'getSelection').mockReturnValue(collapsed as never)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dom.classList.contains('editing')).toBe(true)
    spy.mockRestore()
  })
})

describe('mermaid 点击切换（虚线路径保留）', () => {
  it('mousedown preventDefault + 进编辑 + 光标落位（双 rAF 后 dispatch）', async () => {
    const node = h.parse('```mermaid\ngraph LR\nA-->B\n```\n').firstChild!
    const { dom, renderEl, dispatches } = makeToggle(node, false)
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    renderEl.dispatchEvent(md)
    expect(md.defaultPrevented).toBe(true)
    expect(dom.classList.contains('editing')).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(dispatches.length).toBeGreaterThan(0)
  })

  it('编辑态下再次 mousedown 直接放行', () => {
    const node = h.parse('```mermaid\ngraph LR\nA-->B\n```\n').firstChild!
    const { renderEl } = makeToggle(node, false)
    const first = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    renderEl.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    const second = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    renderEl.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
  })

  it('selectionchange 锚点进入视图 → enter；锚点离开 → leave（mermaid 语义）', () => {
    const node = h.parse('```mermaid\ngraph LR\nA-->B\n```\n').firstChild!
    const { dom } = makeToggle(node, false)
    expect(dom.classList.contains('editing')).toBe(false)
    // 光标（折叠）落在渲染层内 → enter
    const inner = { rangeCount: 1, isCollapsed: true, anchorNode: dom.querySelector('.mf-render'), focusNode: null }
    const spy1 = vi.spyOn(document, 'getSelection').mockReturnValue(inner as never)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dom.classList.contains('editing')).toBe(true)
    // 光标移到正文 → leave
    const outer = { rangeCount: 1, isCollapsed: true, anchorNode: document.body, focusNode: document.body }
    const spy2 = vi.spyOn(document, 'getSelection').mockReturnValue(outer as never)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dom.classList.contains('editing')).toBe(false)
    spy1.mockRestore()
    spy2.mockRestore()
  })
})
