/** 代码块首次拖选（clickToEdit mousedown 放行原生拖选，round-115） */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
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
function makeToggle(node: PMNode, asFences: boolean, posAtCoords?: () => { pos: number } | null) {
  const state = EditorState.create({ doc: h.parse('# t\n\npara\n') })
  const dispatches: number[] = []
  const view = {
    state,
    dispatch: () => dispatches.push(1),
    focus: () => {},
    posAtCoords: posAtCoords ?? (() => null),
  }
  const nv = createToggleView({
    className: 'mf-code',
    render: () => {},
    clickToEdit: true,
    sourceAsFences: () => asFences,
  })(node, view as never, () => 1)
  const dom = nv.dom as HTMLElement
  const renderEl = dom.querySelector('.mf-render') as HTMLElement
  const mousedown = () =>
    renderEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  return { dom, renderEl, mousedown, dispatches }
}

describe('clickToEdit：首次 mousedown 的原生拖选放行', () => {
  it('普通代码块（fences）：不 preventDefault、按压期间不进编辑态（原生拖选在静态渲染层进行），mouseup 纯点击后落位', async () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom, dispatches } = makeToggle(node, true)
    const renderEl = dom.querySelector('.mf-render') as HTMLElement
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    renderEl.dispatchEvent(e)
    // 放行原生拖选：不拦截默认动作，也不中途翻转层叠
    expect(e.defaultPrevented).toBe(false)
    expect(dom.classList.contains('editing')).toBe(false)
    // mouseup（纯点击：选区折叠）→ 进编辑态 + 光标落位（双 rAF 后）
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    expect(dom.classList.contains('editing')).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(dispatches.length).toBeGreaterThan(0)
  })

  it('mermaid（无 contentDOM 形态）：保持 preventDefault + 进编辑（光标落位语义不变）', () => {
    const node = h.parse('```mermaid\ngraph LR\nA-->B\n```\n').firstChild!
    const { dom } = makeToggle(node, false)
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    dom.querySelector('.mf-render')!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
    expect(dom.classList.contains('editing')).toBe(true)
  })

  it('编辑态下再次 mousedown 直接放行（mermaid 二次按下不再拦截）', () => {
    const node = h.parse('```mermaid\ngraph LR\nA-->B\n```\n').firstChild!
    const { dom } = makeToggle(node, false)
    const first = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    dom.querySelector('.mf-render')!.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    const second = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    dom.querySelector('.mf-render')!.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
  })

  it('跨块拖选保位：转换后锚在正文、焦点在 contentDOM，selectionchange 不把已编辑视图踢出（round-119）', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom, renderEl, dispatches } = makeToggle(node, true, () => ({ pos: 4 }))
    // jsdom 下两层都无内容（render 为 no-op、contentDOM 未接 PM）——填文本取节点
    const srcEl = dom.querySelector('.mf-source') as HTMLElement
    renderEl.textContent = 'rendered'
    srcEl.textContent = 'content'
    // 经 mouseup 转换路径进入编辑态（外部拖选落点在本层）
    const landed = {
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: document.body,
      focusNode: renderEl.firstChild,
      getRangeAt: () => ({ getClientRects: () => [{ left: 10, right: 30, top: 0, bottom: 10 }] }),
    }
    const spy1 = vi.spyOn(document, 'getSelection').mockReturnValue(landed as never)
    renderEl.dispatchEvent(new MouseEvent('mouseenter'))
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(dom.classList.contains('editing')).toBe(true)
    expect(dispatches.length).toBeGreaterThan(0)
    // 转换后的真实形态：锚在正文、焦点在 contentDOM——旧逻辑只看锚点
    // 会把视图 leave（焦点被拔出 contentDOM，选区重映射到块边界）
    const spanned = { rangeCount: 1, isCollapsed: false, anchorNode: document.body, focusNode: srcEl.firstChild }
    const spy2 = vi.spyOn(document, 'getSelection').mockReturnValue(spanned as never)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dom.classList.contains('editing')).toBe(true)
    spy1.mockRestore()
    spy2.mockRestore()
  })

  it('非折叠选区焦点路过渲染层不触发进入（119 轮回归钉死：中途 enter 叠出整块第二选区）', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom, renderEl } = makeToggle(node, true)
    renderEl.textContent = 'rendered'
    // 外部拖选中：锚在正文、焦点进入渲染层（非折叠）
    const passing = { rangeCount: 1, isCollapsed: false, anchorNode: document.body, focusNode: renderEl.firstChild }
    const spy = vi.spyOn(document, 'getSelection').mockReturnValue(passing as never)
    document.dispatchEvent(new Event('selectionchange'))
    expect(dom.classList.contains('editing')).toBe(false)
    spy.mockRestore()
  })

  it('外部拖选路过：按压期不翻转层叠，mouseup 焦点在本层才转换（round-119）', () => {
    const node = h.parse('```js\nlet x = 1\n```\n').firstChild!
    const { dom, renderEl } = makeToggle(node, true, () => ({ pos: 4 }))
    renderEl.textContent = 'rendered'
    const external = { rangeCount: 1, isCollapsed: false, anchorNode: document.body, focusNode: document.body }
    const spy1 = vi.spyOn(document, 'getSelection').mockReturnValue(external as never)
    renderEl.dispatchEvent(new MouseEvent('mouseenter'))
    // 不中途翻转（原生选区延伸会在层切换时停摆——实测教训）
    expect(dom.classList.contains('editing')).toBe(false)
    // mouseup：焦点已离开本层（拖回正文松开）→ 不转换
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(dom.classList.contains('editing')).toBe(false)
    // 再来一轮：mouseup 焦点在本层 → 转换
    const landed = {
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: document.body,
      focusNode: renderEl.firstChild,
      getRangeAt: () => ({ getClientRects: () => [{ left: 10, right: 30, top: 0, bottom: 10 }] }),
    }
    const spy2 = vi.spyOn(document, 'getSelection').mockReturnValue(landed as never)
    renderEl.dispatchEvent(new MouseEvent('mouseenter'))
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(dom.classList.contains('editing')).toBe(true)
    spy1.mockRestore()
    spy2.mockRestore()
  })
})
