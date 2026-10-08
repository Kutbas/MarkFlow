/**
 * 自定义节点视图：Typora 式交互——光标进入显示源码，移开显示渲染结果。
 * - code_block：highlight.js 高亮；mermaid 代码块渲染流程图
 * - math_inline / math_block：MathJax（SVG 输出）
 *
 * 关键约束（避免 ProseMirror MutationObserver 反馈死循环）：
 * - 渲染区（renderEl）的所有 DOM 变更必须在 ignoreMutation 中屏蔽
 * - NodeView 自身的属性变更同样屏蔽（PM 不该感知编辑态切换）
 * - 只有 contentDOM（源码区）内的变更交给 PM 处理
 */
import { $view } from '@milkdown/kit/utils'
import { codeBlockSchema, imageSchema } from '@milkdown/kit/preset/commonmark'
import { tableSchema } from '@milkdown/kit/preset/gfm'
import { mathBlockSchema, mathInlineSchema } from '@markflow/shared'
import hljs from 'highlight.js/lib/common'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { NodeView, EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

// ---------- MathJax（懒初始化；liteAdaptor 同构可用，SVG 输出无需外部 CSS） ----------
type MathRenderer = (tex: string, display: boolean) => string
let mathRenderer: MathRenderer | null = null
async function getMathRenderer(): Promise<MathRenderer> {
  if (mathRenderer) return mathRenderer
  const [{ mathjax }, { TeX }, { SVG }, { AllPackages }, { liteAdaptor }, { RegisterHTMLHandler }] =
    await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
    ])
  const adaptor = liteAdaptor({ fontSize: 16 })
  RegisterHTMLHandler(adaptor)
  const doc = mathjax.document('', {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: 'none' }),
  })
  mathRenderer = (source: string, display: boolean) => {
    try {
      const node = doc.convert(source, { display, em: 16, ex: 8, containerWidth: 1280 })
      return adaptor.outerHTML(node)
    } catch {
      return '<span class="mf-math-error">公式解析失败</span>'
    }
  }
  return mathRenderer
}

// ---------- Mermaid（懒加载） ----------
type Mermaid = {
  render: (id: string, src: string) => Promise<{ svg: string }>
  initialize: (opts: Record<string, unknown>) => void
}
let mermaidPromise: Promise<Mermaid> | null = null
function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: document.body.classList.contains('mf-dark') ? 'dark' : 'default',
      })
      return m.default
    })
  }
  return mermaidPromise
}

/** 把光标放进节点内部（点击渲染结果进入源码编辑态） */
function focusNode(view: EditorView, getPos: () => number | undefined): void {
  const pos = getPos()
  if (typeof pos !== 'number') return
  view.focus()
  const $pos = view.state.doc.resolve(pos + 1)
  view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
}

/**
 * 源码/渲染切换调度（Typora 语义）：
 * ProseMirror 整个编辑器是一个 contenteditable，块级 focusout 基本不触发，
 * 因此用全局 selectionchange 判定“光标是否在本视图源码区内”。
 * 注册表设计：enterEdit 的视图进 active 集；每次选区变化只处理
 * 选区命中的那一个视图 + 集合里的既有编辑视图（通常 0~1 个），O(1)。
 */
interface ToggleController {
  el: HTMLElement
  enter: () => void
  leave: () => void
}
const viewRegistry = new WeakMap<HTMLElement, ToggleController>()
const editingControllers = new Set<ToggleController>()

function onDocSelectionChange(): void {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const anchor = sel.getRangeAt(0).commonAncestorContainer
  const anchorEl =
    anchor instanceof Element ? anchor : (anchor.parentElement ?? null)
  const hitEl = (anchorEl?.closest('.mf-toggle-view') as HTMLElement | null) ?? null
  const hit = hitEl ? viewRegistry.get(hitEl) : undefined
  for (const ctrl of [...editingControllers]) {
    if (ctrl !== hit) ctrl.leave()
  }
  hit?.enter()
}

// 点击编辑器之外（侧栏/顶栏）：清空所有编辑态（Typora 行为）
function onDocPointerDown(e: Event): void {
  const target = e.target as Element | null
  if (target?.closest?.('.ProseMirror')) return
  for (const ctrl of [...editingControllers]) ctrl.leave()
}

let dispatchReady = false
function ensureDispatch(): void {
  if (dispatchReady) return
  dispatchReady = true
  document.addEventListener('selectionchange', onDocSelectionChange)
  document.addEventListener('pointerdown', onDocPointerDown, true)
}

/** 通用“源码/渲染”切换视图工厂 */
export function createToggleView(options: {
  className: string
  render: (source: string, renderEl: HTMLElement, node: PMNode) => Promise<void> | void
  /** 渲染区可点击进入编辑（mermaid/math 需要） */
  clickToEdit?: boolean
  /** 内联节点（行内公式等）：容器用 span，避免块级 div 强制断行 */
  inline?: boolean
}): (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  const { className, render } = options
  return (node, view, getPos) => {
    let currentNode = node
    const tag = options.inline ? 'span' : 'div'
    const dom = document.createElement(tag)
    dom.className = `mf-toggle-view ${className}`
    const renderEl = document.createElement(tag)
    renderEl.className = 'mf-render'
    const srcEl = document.createElement(tag)
    srcEl.className = 'mf-source'
    dom.appendChild(renderEl)
    dom.appendChild(srcEl)

    let editing = false
    let renderToken = 0

    const refresh = async () => {
      const token = ++renderToken
      try {
        await render(currentNode.textContent, renderEl, currentNode)
      } catch {
        renderEl.textContent = '渲染失败'
      }
      if (token !== renderToken) return
      if (!editing) dom.classList.remove('editing')
    }

    const enterEdit = () => {
      if (editing) return
      editing = true
      dom.classList.add('editing')
      const ctrl = controller
      if (ctrl) editingControllers.add(ctrl)
    }
    const leaveEdit = () => {
      if (!editing) return
      editing = false
      dom.classList.remove('editing')
      const ctrl = controller
      if (ctrl) editingControllers.delete(ctrl)
      void refresh()
    }

    const controller: ToggleController = { el: dom, enter: enterEdit, leave: leaveEdit }
    viewRegistry.set(dom, controller)
    ensureDispatch()

    if (options.clickToEdit) {
      renderEl.addEventListener('mousedown', (e) => {
        if (editing) return
        e.preventDefault()
        enterEdit()
        focusNode(view, getPos)
      })
    }

    const viewNode: NodeView = {
      dom,
      contentDOM: srcEl,
      update(updated: PMNode) {
        if (updated.type !== currentNode.type) return false
        const changed =
          updated.textContent !== currentNode.textContent ||
          JSON.stringify(updated.attrs) !== JSON.stringify(currentNode.attrs)
        currentNode = updated
        if (changed && !editing) void refresh()
        return true
      },
      ignoreMutation: (mutation) => {
        const target = mutation.target as HTMLElement
        // 渲染区与自身的属性/结构切换不属于文档变化，必须屏蔽，
        // 否则 PM 的 MutationObserver 会把这些 DOM 写入当作内容变化重新解析
        if (renderEl.contains(target)) return true
        if (target === dom && mutation.type === 'attributes') return true
        return false
      },
      stopEvent: (e) => renderEl.contains(e.target as globalThis.Node) && !editing,
      destroy() {
        renderToken++
        viewRegistry.delete(dom)
        editingControllers.delete(controller)
      },
    }

    void refresh()
    return viewNode
  }
}

// ---------- code_block ----------
/** 常用语言建议列表（右下角输入框的 datalist） */
const LANG_SUGGESTIONS = [
  'mermaid', 'typescript', 'javascript', 'python', 'bash', 'shell', 'json',
  'yaml', 'html', 'css', 'sql', 'cpp', 'c', 'java', 'go', 'rust', 'text',
]

/** 给代码块视图挂一个 Typora 式右下角语言输入框（修改 language 属性即时重渲染） */
function withLanguageInput(
  factory: ReturnType<typeof createToggleView>,
): ReturnType<typeof createToggleView> {
  return (node, view, getPos) => {
    const viewNode = factory(node, view, getPos) as NodeView & {
      dom: HTMLElement
      update: (n: PMNode) => boolean
    }
    const dom = viewNode.dom
    dom.classList.add('mf-code-block')

    let list = document.getElementById('mf-lang-list') as HTMLDataListElement | null
    if (!list) {
      list = document.createElement('datalist')
      list.id = 'mf-lang-list'
      for (const lang of LANG_SUGGESTIONS) {
        const opt = document.createElement('option')
        opt.value = lang
        list.appendChild(opt)
      }
      document.body.appendChild(list)
    }

    const input = document.createElement('input')
    input.className = 'mf-lang-input'
    input.setAttribute('list', 'mf-lang-list')
    input.placeholder = '语言'
    input.spellcheck = false
    input.value = String(node.attrs['language'] ?? '')
    const apply = () => {
      const pos = getPos()
      const lang = input.value.trim().toLowerCase()
      if (typeof pos !== 'number' || lang === String(node.attrs['language'] ?? '')) return
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: lang }),
      )
    }
    input.addEventListener('change', apply)
    input.addEventListener('blur', apply) // JS 设值不触发 change，blur 兜底（幂等）
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
      e.stopPropagation()
    })
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    dom.appendChild(input)

    const origUpdate = viewNode.update.bind(viewNode)
    viewNode.update = (updated: PMNode) => {
      const ok = origUpdate(updated)
      if (ok) {
        node = updated
        input.value = String(updated.attrs['language'] ?? '')
      }
      return ok
    }
    // 复制按钮（右上角，hover 可见）
    const copyBtn = document.createElement('button')
    copyBtn.className = 'mf-copy-btn'
    copyBtn.textContent = '复制'
    copyBtn.title = '复制代码'
    copyBtn.addEventListener('mousedown', (e) => e.stopPropagation())
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const text = node.textContent
      void navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = '已复制'
        copyBtn.classList.add('copied')
        setTimeout(() => {
          copyBtn.textContent = '复制'
          copyBtn.classList.remove('copied')
        }, 2000)
      })
    })
    dom.appendChild(copyBtn)

    const origDestroy = (viewNode as { destroy?: () => void }).destroy?.bind(viewNode)
    ;(viewNode as { destroy?: () => void }).destroy = () => {
      input.remove()
      copyBtn.remove()
      origDestroy?.()
    }
    // 事件不交给 ProseMirror（输入框是纯 UI 控件）
    const inner = viewNode as unknown as { stopEvent: (e: Event) => boolean }
    const origStop = inner.stopEvent?.bind(viewNode)
    inner.stopEvent = (e: Event) => {
      if (e.target === input || e.target === copyBtn) return true
      return origStop ? origStop(e) : false
    }
    const innerIgnore = viewNode as unknown as { ignoreMutation: (m: MutationRecord) => boolean }
    const origIgnore = innerIgnore.ignoreMutation?.bind(viewNode)
    innerIgnore.ignoreMutation = (m: MutationRecord) => {
      if (m.target === input || input.contains(m.target as globalThis.Node)) return true
      if (m.target === copyBtn || copyBtn.contains(m.target as globalThis.Node)) return true
      return origIgnore ? origIgnore(m) : false
    }
    return viewNode
  }
}

export const codeBlockView = $view(codeBlockSchema.node, () =>
  withLanguageInput(createToggleView({
    className: 'mf-code',
    render(source, renderEl, node) {
      const lang = String(node.attrs['language'] ?? '')
      if (lang === 'mermaid') {
        renderEl.classList.add('mermaid')
        renderEl.innerHTML = '图表生成中…'
        const id = `mf-mermaid-${Math.random().toString(36).slice(2, 9)}`
        return getMermaid()
          .then((m) => m.render(id, source))
          .then(({ svg }) => {
            renderEl.innerHTML = svg
          })
          .catch((err: unknown) => {
            renderEl.innerHTML = `<div class="mf-render-error">Mermaid 图表有误：${
              (err as Error)?.message ?? err
            }</div>`
          })
      }
      renderEl.classList.remove('mermaid')
      renderEl.innerHTML = ''
      const pre = document.createElement('pre')
      pre.classList.add('md-fences') // Typora 主题兼容类
      const code = document.createElement('code')
      if (lang && hljs.getLanguage(lang)) {
        code.className = `hljs language-${lang}`
      } else {
        code.className = lang ? `language-${lang}` : ''
      }
      if (lang) pre.setAttribute('data-language', lang)
      renderEl.appendChild(pre).appendChild(code)

      // 行号：逐行切分 + CSS counter（一行代码一行行号同容器，结构性对齐零漂移）
      const lines = source.split('\n')
      if (lang !== 'mermaid' && lines.length > 1) {
        pre.classList.add('mf-lineno')
        for (const line of lines) {
          const row = document.createElement('span')
          row.className = 'mf-cl'
          if (line === '') {
            row.innerHTML = '\u00a0'
          } else if (lang && hljs.getLanguage(lang)) {
            row.innerHTML = hljs.highlight(line, { language: lang, ignoreIllegals: true }).value
          } else {
            row.textContent = line
          }
          code.appendChild(row)
        }
      } else {
        // 单行或 mermaid：整块高亮（不需要行号）
        if (lang && hljs.getLanguage(lang) && lang !== 'mermaid') {
          code.innerHTML = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value
        } else {
          code.textContent = source
        }
      }
    },
  })),
)

// ---------- image ----------
/**
 * 图片视图：点击显示源码编辑框（Typora 行为），可修改 alt/src，失焦恢复。
 * 图片是原子节点（无 contentDOM），独立实现（不走 toggle 模式）。
 */
export const imageView = $view(imageSchema.node, () => {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
    let currentNode = node
    const dom = document.createElement('span')
    dom.className = 'mf-image'

    const img = document.createElement('img')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'mf-image-src'
    input.spellcheck = false
    dom.appendChild(img)
    dom.appendChild(input)

    function renderImg(): void {
      const src = String(currentNode.attrs['src'] ?? '')
      const alt = String(currentNode.attrs['alt'] ?? '')
      img.alt = alt
      const pageOrigin = (globalThis as { location?: { origin: string } }).location?.origin ?? ''
      const sameOrigin = pageOrigin !== '' && src.startsWith(pageOrigin)
      img.src =
        src && /^https?:\/\//.test(src) && !sameOrigin
          ? `/api/img?u=${encodeURIComponent(src)}`
          : src
    }

    function enterEdit(): void {
      dom.classList.add('editing')
      input.value = `![${currentNode.attrs['alt' ] ?? ''}](${currentNode.attrs['src'] ?? ''})`
      input.focus()
      input.select()
    }

    function applyAndLeave(): void {
      dom.classList.remove('editing')
      const v = input.value.trim()
      // 解析 ![alt](url)
      const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(v)
      const pos = getPos()
      if (m && typeof pos === 'number') {
        const [, alt, src] = m
        if (alt !== currentNode.attrs['alt'] || src !== currentNode.attrs['src']) {
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...currentNode.attrs,
              alt,
              src,
            }),
          )
        }
      }
      renderImg()
    }

    input.addEventListener('blur', applyAndLeave)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault()
        input.blur()
      }
      e.stopPropagation()
    })
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    img.addEventListener('mousedown', (e) => {
      if (dom.classList.contains('editing')) return
      e.preventDefault()
      enterEdit()
    })

    renderImg()

    return {
      dom,
      update(updated: PMNode) {
        if (updated.type !== currentNode.type) return false
        currentNode = updated
        if (!dom.classList.contains('editing')) renderImg()
        return true
      },
      ignoreMutation: (mutation: MutationRecord) => {
        return input.contains(mutation.target as globalThis.Node) || mutation.target === dom
      },
      stopEvent: (e: Event) => {
        return input.contains(e.target as globalThis.Node) || (!dom.classList.contains('editing') && e.target === img)
      },
      destroy() {
        input.removeEventListener('blur', applyAndLeave)
      },
    } as unknown as NodeView
  }
})

// ---------- table ----------
/**
 * 表格视图：右上角悬浮"源码"按钮（hover 可见），点击显示 markdown 管道语法可编辑，
 * 失焦后把修改的 markdown 解析并替换表格节点。表格本身保持原生单元格编辑。
 */
export const tableView = $view(tableSchema.node, () => {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined) => {
    let currentNode = node
    const dom = document.createElement('div')
    dom.className = 'mf-table-view'

    // 源码编辑区
    const textarea = document.createElement('textarea')
    textarea.className = 'mf-table-src'
    textarea.spellcheck = false
    dom.appendChild(textarea)

    const srcBtn = document.createElement('button')
    srcBtn.className = 'mf-table-src-btn'
    srcBtn.textContent = '源码'
    srcBtn.title = '查看/编辑 Markdown 源码'
    dom.appendChild(srcBtn)

    // 渲染静态 HTML 表格
    function renderTable(): void {
      // 移除旧渲染（如果有）
      const old = dom.querySelector('.mf-table-render')
      old?.remove()
      const wrap = document.createElement('div')
      wrap.className = 'mf-table-render'
      // 从 PM 节点结构生成 HTML 表格
      const tbl = document.createElement('table')
      currentNode.forEach((row: PMNode) => {
        const tr = document.createElement(row.type.name === 'table_header_row' ? 'thead' : 'tbody')
        const trEl = document.createElement('tr')
        row.forEach((cell: PMNode) => {
          const cellEl = document.createElement(
            row.type.name === 'table_header_row' ? 'th' : 'td',
          )
          if (cell.attrs['alignment']) {
            cellEl.style.textAlign = String(cell.attrs['alignment'])
          }
          cellEl.textContent = cell.textContent
          trEl.appendChild(cellEl)
        })
        tr.appendChild(trEl)
        tbl.appendChild(tr)
      })
      wrap.appendChild(tbl)
      dom.appendChild(wrap)
    }

    function enterEdit(): void {
      dom.classList.add('editing')
      // 序列化为 markdown 管道语法
      const { serialize } = getHeadlessCached()
      void serialize(currentNode).then((md) => {
        textarea.value = md.trim()
      })
      textarea.focus()
    }

    function applyAndLeave(): void {
      dom.classList.remove('editing')
      const md = textarea.value.trim()
      const pos = getPos()
      if (!md || typeof pos !== 'number') {
        renderTable()
        return
      }
      // 解析 markdown → PM 节点 → 替换表格
      const { parse } = getHeadlessCached()
      void parse(md).then((newNode) => {
        if (newNode.type.name === currentNode.type.name) {
          view.dispatch(
            view.state.tr.replaceWith(pos, pos + currentNode.nodeSize, newNode.content),
          )
        }
        renderTable()
      })
    }

    srcBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (dom.classList.contains('editing')) {
        applyAndLeave()
      } else {
        enterEdit()
      }
    })
    textarea.addEventListener('blur', applyAndLeave)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        textarea.blur()
      }
      e.stopPropagation()
    })

    let headlessCache: { parse: (s: string) => Promise<PMNode>; serialize: (n: PMNode) => Promise<string> } | null = null
    function getHeadlessCached() {
      headlessCache ??= {
        parse: (s) => import('@markflow/shared/headless').then(({ getHeadless }) => getHeadless()).then(({ parse }) => parse(s)),
        serialize: (_n) => {
          // 用 PM 的 JSON 序列化（无需完整 markdown 管道——只用于展示）
          // 简易管道语法生成
          const rows: string[][] = []
          const aligns: (string | null)[] = []
          currentNode.forEach((row: PMNode) => {
            const cells: string[] = []
            row.forEach((cell: PMNode, i: number) => {
              cells.push(cell.textContent.replace(/\|/g, '\\|'))
              if (aligns.length <= i) aligns.push((cell.attrs['alignment'] as string | null) ?? null)
            })
            rows.push(cells)
          })
          if (rows.length === 0) return Promise.resolve('')
          const lines: string[] = []
          lines.push('| ' + rows[0]!.join(' | ') + ' |')
          lines.push('| ' + aligns.map((a) => a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---').join(' | ') + ' |')
          for (let i = 1; i < rows.length; i++) {
            lines.push('| ' + rows[i]!.join(' | ') + ' |')
          }
          return Promise.resolve(lines.join('\n'))
        },
      }
      return headlessCache
    }

    renderTable()

    return {
      dom,
      update(updated: PMNode) {
        if (updated.type !== currentNode.type) return false
        currentNode = updated
        if (!dom.classList.contains('editing')) renderTable()
        return true
      },
      ignoreMutation: (m: MutationRecord) => {
        return textarea.contains(m.target as globalThis.Node) || srcBtn.contains(m.target as globalThis.Node) || m.target === dom
      },
      stopEvent: (e: Event) => {
        return textarea.contains(e.target as globalThis.Node) || e.target === srcBtn
      },
      destroy() {
        textarea.removeEventListener('blur', applyAndLeave)
      },
    } as unknown as NodeView
  }
})

// ---------- math ----------
export const mathBlockView = $view(mathBlockSchema.node, () =>
  createToggleView({
    className: 'mf-math mf-math-block md-math-block',
    clickToEdit: true,
    render(source, renderEl) {
      return getMathRenderer().then((r) => {
        renderEl.innerHTML = r(source, true)
      })
    },
  }),
)

export const mathInlineView = $view(mathInlineSchema.node, () =>
  createToggleView({
    className: 'mf-math mf-math-inline md-math-inline',
    clickToEdit: true,
    inline: true,
    render(source, renderEl) {
      return getMathRenderer().then((r) => {
        renderEl.innerHTML = r(source, false)
      })
    },
  }),
)

export const mathViews = [mathBlockView, mathInlineView]
