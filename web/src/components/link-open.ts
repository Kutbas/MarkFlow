/**
 * Ctrl/Cmd + 单击打开超链接（浏览器行为）：
 * 编辑区内的 <a> 按住修饰键点击 → 新标签打开；普通单击仍是编辑定位
 * （进入链接文本 → 源码展开为 [文本](地址)，见 mark-source-reveal）。
 * 仅放行 http(s)（防 javascript: 等协议注入）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

export const linkOpenKey = new PluginKey('mf-link-open')

/** 修饰键单击是否指向可打开的 http(s) 链接（mousedown/click 两处共用判定） */
function openableAnchor(e: MouseEvent): HTMLAnchorElement | null {
  // Cmd（mac）/ Ctrl（win/linux）+ 主键；mac 上 Ctrl+单击原生就是右键，不冲突
  if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return null
  const target = e.target as HTMLElement | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return null
  const href = anchor.getAttribute('href') ?? ''
  if (!/^https?:\/\//i.test(href)) return null
  return anchor
}

export const linkOpenPlugin = new Plugin({
  key: linkOpenKey,
  props: {
    handleDOMEvents: {
      // 必须在 mousedown 就拦：放任默认行为落光标 → 光标进入链接区 →
      // 源码展开把 <a> 替换成字面文本（~20ms 异步 flush），click 合成时
      // closest('a') 落空——第一次单击只展开不打开，要点两次。
      // preventDefault mousedown = 光标不动 + <a> 完好，click 正常打开。
      mousedown(_view, event) {
        const e = event as MouseEvent
        if (openableAnchor(e)) e.preventDefault()
        return false
      },
      click(_view, event) {
        const e = event as MouseEvent
        const anchor = openableAnchor(e)
        if (!anchor) return false
        e.preventDefault()
        window.open(anchor.getAttribute('href') ?? '', '_blank', 'noopener,noreferrer')
        return true
      },
    },
  },
})
