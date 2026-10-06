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
import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
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

/** 通用“源码/渲染”切换视图工厂 */
export function createToggleView(options: {
  className: string
  render: (source: string, renderEl: HTMLElement, node: PMNode) => Promise<void> | void
  /** 渲染区可点击进入编辑（mermaid/math 需要） */
  clickToEdit?: boolean
}): (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  const { className, render } = options
  return (node, view, getPos) => {
    let currentNode = node
    const dom = document.createElement('div')
    dom.className = `mf-toggle-view ${className}`
    const renderEl = document.createElement('div')
    renderEl.className = 'mf-render'
    const srcEl = document.createElement('div')
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
    }
    const leaveEdit = () => {
      if (!editing) return
      editing = false
      dom.classList.remove('editing')
      void refresh()
    }

    dom.addEventListener('focusin', enterEdit)
    dom.addEventListener('focusout', leaveEdit)
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
        dom.removeEventListener('focusin', enterEdit)
        dom.removeEventListener('focusout', leaveEdit)
      },
    }

    void refresh()
    return viewNode
  }
}

// ---------- code_block ----------
export const codeBlockView = $view(codeBlockSchema.node, () =>
  createToggleView({
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
      const pre = document.createElement('pre')
      pre.classList.add('md-fences') // Typora 主题兼容类
      const code = document.createElement('code')
      if (lang && hljs.getLanguage(lang)) {
        code.className = `hljs language-${lang}`
        code.innerHTML = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value
      } else {
        code.className = lang ? `language-${lang}` : ''
        code.textContent = source
      }
      if (lang) pre.setAttribute('data-language', lang)
      renderEl.innerHTML = ''
      renderEl.appendChild(pre).appendChild(code)
    },
  }),
)

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
    render(source, renderEl) {
      return getMathRenderer().then((r) => {
        renderEl.innerHTML = r(source, false)
      })
    },
  }),
)

export const mathViews = [mathBlockView, mathInlineView]
