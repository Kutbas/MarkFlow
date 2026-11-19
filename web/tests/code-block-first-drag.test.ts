/** 代码块首次拖选（clickToEdit mousedown 放行原生拖选，round-115） */
import { beforeAll, describe, expect, it } from 'vitest'
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
function makeToggle(node: PMNode, asFences: boolean) {
  const state = EditorState.create({ doc: h.parse('# t\n\npara\n') })
  const dispatches: number[] = []
  const view = {
    state,
    dispatch: () => dispatches.push(1),
    focus: () => {},
    posAtCoords: () => null,
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
  return { dom, mousedown, dispatches }
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
})
