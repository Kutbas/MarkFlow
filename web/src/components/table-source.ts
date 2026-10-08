/**
 * 表格源码编辑 + 远端光标用户色指示
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Awareness } from 'y-protocols/awareness'

// ============================================================
// 表格源码按钮（widget decoration，hover 可见，不干扰原生编辑）
// ============================================================

function tableToMarkdown(node: PMNode): string {
  const rows: string[][] = []
  const aligns: (string | null)[] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell, i) => {
      cells.push(cell.textContent.replace(/\|/g, '\\|'))
      if (aligns.length <= i) aligns.push((cell.attrs['alignment'] as string | null) ?? null)
    })
    rows.push(cells)
  })
  if (rows.length === 0) return ''
  const lines: string[] = []
  lines.push('| ' + rows[0]!.join(' | ') + ' |')
  lines.push('| ' + aligns.map((a) => (a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---')).join(' | ') + ' |')
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + rows[i]!.join(' | ') + ' |')
  }
  return lines.join('\n')
}

interface EditorViewLike {
  dispatch: (tr: unknown) => void
  state: { tr: { replaceWith: (from: number, to: number, content: unknown) => unknown } }
}

function openTableSourceEditor(node: PMNode, view: EditorViewLike, pos: number): void {
  const overlay = document.createElement('div')
  overlay.className = 'mf-table-editor-overlay'
  const panel = document.createElement('div')
  panel.className = 'mf-table-editor-panel'
  const textarea = document.createElement('textarea')
  textarea.className = 'mf-table-editor-textarea'
  textarea.value = tableToMarkdown(node)
  textarea.rows = Math.max(4, (textarea.value.match(/\n/g) ?? []).length + 2)
  const btnRow = document.createElement('div')
  btnRow.className = 'mf-table-editor-btns'
  const okBtn = document.createElement('button')
  okBtn.textContent = '应用'
  okBtn.className = 'mf-table-editor-ok'
  const cancelBtn = document.createElement('button')
  cancelBtn.textContent = '取消'
  cancelBtn.className = 'mf-table-editor-cancel'
  btnRow.appendChild(okBtn)
  btnRow.appendChild(cancelBtn)
  panel.appendChild(textarea)
  panel.appendChild(btnRow)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  cancelBtn.addEventListener('click', close)
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  okBtn.addEventListener('click', async () => {
    const md = textarea.value.trim()
    if (!md) { close(); return }
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    try {
      const newNode = parse(md)
      if (newNode.type.name === node.type.name) {
        view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, newNode.content))
      }
    } catch { /* 解析失败静默 */ }
    close()
  })

  textarea.focus()
}

export const tableSourcePlugin = new Plugin({
  key: new PluginKey('mfTableSource'),
  state: {
    init: (_, state) => buildTableDecorations(state.doc),
    apply: (tr, prev, _old, newState) => {
      if (!tr.docChanged) return prev
      return buildTableDecorations(newState.doc)
    },
  },
  props: {
    decorations(state) {
      return this.getState(state)
    },
  },
})

function buildTableDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const btn = document.createElement('button')
          btn.className = 'mf-table-src-btn'
          btn.textContent = '源码'
          btn.title = '查看/编辑 Markdown 源码'
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            const editor = document.querySelector('.ProseMirror') as HTMLElement & {
              pmViewDesc?: { view: EditorViewLike }
            }
            const view = editor?.pmViewDesc?.view
            if (view) openTableSourceEditor(node, view, pos)
          })
          return btn
        },
        { side: -1, key: `table-src-${pos}`, ignoreSelection: true },
      ),
    )
  })
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

// ============================================================
// 远端光标指示器（用户色 + 名字标签）
// MutationObserver 监听 DOM 中远端 cursor widget 的插入，
// 从 widget 的 border-color 读取用户颜色，应用到父容器。
// ============================================================

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
