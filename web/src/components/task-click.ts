/**
 * 任务列表点击切换（Typora 行为）：点击 li 左侧悬挂的勾选框区域（::before 伪元素，
 * flex 布局下负 margin 悬挂在内容盒左侧 1.4em）→ 切换 list_item 的 checked 属性。
 * 伪元素无法直接绑定事件，但点击伪元素时 event.target 是宿主 li——
 * 用 clientX 与 li 内容盒左边界的相对位置判定命中。
 * 符号区连击（双击第二击起）吞掉 mousedown——阻止浏览器/PM 的选词与
 * 三击选段默认行为（快速切换勾选时意外出现整行蓝色选区，用户实测）；
 * 正文文字区的多击选段是标准编辑器行为，保持放行。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

export const taskClickKey = new PluginKey('mf-task-click')

/** 点击坐标是否落在勾选框悬挂区（li 内容盒左边界向外 1.4em+4px 容差） */
function inCheckboxArea(el: Element, clientX: number): boolean {
  const liRect = el.getBoundingClientRect()
  const fs = parseFloat(getComputedStyle(el).fontSize) || 16
  const boxWidth = fs * 1.4 + 4
  return clientX <= liRect.left && clientX >= liRect.left - boxWidth
}

export const taskClickToggle = new Plugin({
  key: taskClickKey,
  props: {
    handleDOMEvents: {
      mousedown(_view, event) {
        const e = event as MouseEvent
        if (e.detail < 2) return false // 单击放行（handleClick 切换勾选）
        const el = (e.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
        if (!el || !inCheckboxArea(el, e.clientX)) return false
        return true // 符号区双击/三击：吞掉，不触发选词/选块
      },
    },
    // 双保险：PM 专用双击/三击拦截点（真实事件必经，不依赖 mousedown
    // preventDefault 是否彻底阻断选词/选段链路）
    handleDoubleClick(_view, _pos, event) {
      const e = event as MouseEvent
      const el = (e.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
      if (!el || !inCheckboxArea(el, e.clientX)) return false
      return true
    },
    handleTripleClick(_view, _pos, event) {
      const e = event as MouseEvent
      const el = (e.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
      if (!el || !inCheckboxArea(el, e.clientX)) return false
      return true
    },
    handleClick(view, _pos, event) {
      const el = (event.target as HTMLElement | null)?.closest?.('li[data-item-type="task"]')
      if (!el) return false
      if (!inCheckboxArea(el, (event as MouseEvent).clientX)) return false

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
