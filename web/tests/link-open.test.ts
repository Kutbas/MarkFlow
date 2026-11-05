/** Ctrl/Cmd+单击打开链接：mousedown 拦截（阻展开抢跑）+ click 打开 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { linkOpenPlugin } from '../src/components/link-open'

type Handlers = Record<string, (view: unknown, event: Event) => boolean | void>
const handlers = (linkOpenPlugin.props as { handleDOMEvents: Handlers }).handleDOMEvents

/** 构造挂在 DOM 上的事件（target 经 dispatch 自然设置），并送入插件 handler */
function fire(el: Element, type: 'mousedown' | 'click', opts: MouseEventInit): { ev: MouseEvent; handled: boolean | void } {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...opts })
  el.dispatchEvent(ev)
  const handled = handlers[type]!(null, ev)
  return { ev, handled }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('link-open（修饰键单击打开）', () => {
  it('mousedown 命中 http 链接 → preventDefault（光标不落 → 不触发展开，click 才能打开）', () => {
    const a = document.createElement('a')
    a.href = 'https://example.com'
    a.textContent = '链接'
    document.body.appendChild(a)
    const { ev } = fire(a, 'mousedown', { metaKey: true })
    expect(ev.defaultPrevented).toBe(true)
  })

  it('无修饰键 mousedown → 不拦截（普通单击仍落光标展开源码）', () => {
    const a = document.createElement('a')
    a.href = 'https://example.com'
    document.body.appendChild(a)
    const { ev } = fire(a, 'mousedown', {})
    expect(ev.defaultPrevented).toBe(false)
  })

  it('修饰键 click → window.open 新标签（noopener）', () => {
    const open = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', open)
    const a = document.createElement('a')
    a.href = 'https://example.com'
    document.body.appendChild(a)
    const { ev, handled } = fire(a, 'click', { metaKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(handled).toBe(true)
  })

  it('javascript: 协议 → mousedown/click 均不动作（防注入）', () => {
    const open = vi.fn().mockReturnValue(null)
    vi.stubGlobal('open', open)
    const a = document.createElement('a')
    a.href = 'javascript:alert(1)'
    document.body.appendChild(a)
    const down = fire(a, 'mousedown', { metaKey: true })
    const click = fire(a, 'click', { metaKey: true })
    expect(down.ev.defaultPrevented).toBe(false)
    expect(click.ev.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
