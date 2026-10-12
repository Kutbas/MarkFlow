/**
 * Ctrl/Cmd + 单击打开超链接（浏览器行为）：
 * 编辑区内的 <a> 按住修饰键点击 → 新标签打开；普通单击仍是编辑定位。
 * 仅放行 http(s)（防 javascript: 等协议注入）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

export const linkOpenKey = new PluginKey('mf-link-open')

export const linkOpenPlugin = new Plugin({
  key: linkOpenKey,
  props: {
    handleDOMEvents: {
      click(_view, event) {
        const e = event as MouseEvent
        // Cmd（mac）/ Ctrl（win/linux）+ 主键；mac 上 Ctrl+单击原生就是右键，不冲突
        if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return false
        const target = e.target as HTMLElement | null
        const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
        if (!anchor) return false
        const href = anchor.getAttribute('href') ?? ''
        if (!/^https?:\/\//i.test(href)) return false
        e.preventDefault()
        window.open(href, '_blank', 'noopener,noreferrer')
        return true
      },
    },
  },
})
