/**
 * 任务列表点击切换（Typora 行为）：点击 li 左侧悬挂的勾选框区域（::before 伪元素，
 * flex 布局下负 margin 悬挂在内容盒左侧 1.4em）→ 切换 list_item 的 checked 属性。
 * 伪元素无法直接绑定事件，但点击伪元素时 event.target 是宿主 li——
 * 用 clientX 与 li 内容盒左边界的相对位置判定命中。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

export const taskClickKey = new PluginKey('mf-task-click')

export const taskClickToggle = new Plugin({
  key: taskClickKey,
  props: {
    handleClick(view, _pos, event) {
      const el = (event.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
      if (!el) return false
      const liRect = el.getBoundingClientRect()
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16
      const boxWidth = fs * 1.4 + 4 // 勾选框悬挂宽度 + 点击容差
      const x = (event as MouseEvent).clientX
      // 只响应勾选框区域：li 内容盒左边界向外 boxWidth 像素内
      if (x > liRect.left || x < liRect.left - boxWidth) return false

      // 点击落在 li 盒外（伪元素悬挂区），PM 给的 pos 可能不含该 li——用 posAtDOM 从宿主重新映射
      const inner = view.posAtDOM(el as unknown as Node, 0)
      const $pos = view.state.doc.resolve(inner)
      for (let d = $pos.depth; d > 0; d--) {
        const node = $pos.node(d)
        const checked = node.attrs['checked'] as boolean | null
        if (node.type.name === 'list_item' && checked != null) {
          view.dispatch(
            view.state.tr.setNodeMarkup($pos.before(d), undefined, {
              ...node.attrs,
              checked: !checked,
            }),
          )
          return true
        }
      }
      return false
    },
  },
})
