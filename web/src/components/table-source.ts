/**
 * 远端光标指示器（用户色 + 名字标签）
 * MutationObserver 监听 DOM 中远端 cursor widget 的插入，
 * 从 widget 的 border-color 读取用户颜色，应用到父容器。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { Awareness } from 'y-protocols/awareness'

export function remoteCursorIndicator(awareness: Awareness): Plugin {
  let observer: MutationObserver | null = null

  return new Plugin({
    key: new PluginKey('mfRemoteCursor'),
    view: (view) => {
      const root = view.dom

      const applyIndicators = () => {
        root.querySelectorAll('.mf-remote-active').forEach((el) => {
          el.classList.remove('mf-remote-active')
          el.removeAttribute('data-remote-name')
          el.removeAttribute('style')
        })

        const cursors = root.querySelectorAll<HTMLElement>('.ProseMirror-yjs-cursor')
        for (const cursor of cursors) {
          if (cursor.offsetParent !== null) continue // 已在可见区域

          const container = cursor.closest<HTMLElement>('.mf-toggle-view, .mf-image')
          if (!container || container.classList.contains('mf-remote-active')) continue

          const color = cursor.style.borderColor || '#e11d48'
          const nameEl = cursor.querySelector('div')
          const name = nameEl?.textContent?.trim() || ''
          container.classList.add('mf-remote-active')
          container.setAttribute('data-remote-name', name)
          container.style.outlineColor = color
          container.style.setProperty('--mf-remote-color', color)
        }
      }

      observer = new MutationObserver(() => {
        applyIndicators()
      })
      observer.observe(root, { childList: true, subtree: true })

      const onAwareness = () => {
        requestAnimationFrame(applyIndicators)
      }
      awareness.on('update', onAwareness)

      return {
        destroy: () => {
          observer?.disconnect()
          awareness.off('update', onAwareness)
        },
      }
    },
    state: {
      init: () => ({}),
      apply: () => ({}),
    },
  })
}
