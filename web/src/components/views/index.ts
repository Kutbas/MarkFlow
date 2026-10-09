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
type MermaidInit = { initialize: (opts: Record<string, unknown>) => void }
let mermaidPromise: Promise<Mermaid> | null = null

/** mermaid 全局配置（可重复 initialize：render 前按容器宽重设 gantt 布局宽） */
function mermaidConfig(): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'loose',
    // 语法错误时不往页面尾部插入巨大的错误 SVG（会溢出挤占排版）
    suppressErrorRendering: true,
    theme: document.body.classList.contains('mf-dark') ? 'dark' : 'default',
    // gantt 布局宽度：默认 300px 会把任务文字挤爆，设为常规版心宽（render 前按容器再校准）
    gantt: { useWidth: 640 },
  }
}

function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      ;(m.default as unknown as MermaidInit).initialize(mermaidConfig())
      return m.default
    })
  }
  return mermaidPromise
}

/**
 * mermaid render 串行队列：mermaid 的 render 有内部全局状态、不支持并发——
 * 频繁切换大文档（多个图表视图同时创建/销毁）时并发 render 会让临时容器
 * （#d{id}，挂在 body 末尾）改名或逃逸清理，残留在页面流里挤占排版。
 * 全局排队，一次只跑一个 render。
 */
let mermaidRenderQueue: Promise<unknown> = Promise.resolve()
function serializeMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const next = mermaidRenderQueue.then(task, task)
  mermaidRenderQueue = next.catch(() => {})
  return next
}

/**
 * mermaid 边标签防重叠（渲染后处理）：
 * dagre/ELK 布局引擎都可能把同源多条出边的中心标签放到同一坐标
 * （如「A -->|标签1| B」「A -->|标签2| C」，两条边近平行时中点重合），
 * mermaid 也没有暴露边标签间距配置。渲染完成后检测 g.edgeLabel 的
 * 包围盒碰撞，把碰撞的标签沿 y 向排开（各自保持 x 不动）。
 */
const EDGE_LABEL_GAP = 10
const EDGE_OBSTACLE_GAP = 8
function deoverlapEdgeLabels(container: HTMLElement): void {
  const svg = container.querySelector('svg')
  if (!svg) return
  interface LabelItem {
    el: SVGGElement
    cx: number
    cy: number
    w: number
    h: number
  }
  const items: LabelItem[] = []
  for (const el of svg.querySelectorAll<SVGGElement>('g.edgeLabel')) {
    // 标签中心由外层 transform 定位（内部 g.label 以 translate(-w/2, -h/2) 居中）
    const m = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/.exec(
      el.getAttribute('transform') ?? '',
    )
    if (!m) continue
    const cx = +m[1]!
    const cy = +m[2]!
    const bb = el.getBBox()
    if (!bb.width || !bb.height) continue
    items.push({ el, cx, cy, w: bb.width, h: bb.height })
  }
  if (items.length === 0) return

  // 两两碰撞 + 并查集聚类（标签数量少，O(n²) 足够）
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    const p = parent[i]!
    return p === i ? i : (parent[i] = find(p))
  }
  const hits = (a: LabelItem, b: LabelItem) =>
    Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 - 1 && Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 - 1
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!
      if (hits(a, b)) parent[find(i)] = find(j)
    }
  }
  const clusters = new Map<number, LabelItem[]>()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    let list = clusters.get(root)
    if (!list) {
      list = []
      clusters.set(root, list)
    }
    list.push(items[i]!)
  }

  // 碰撞簇内沿 y 排开：以簇内首尾中心的中点为轴，按高度顺序紧密堆叠
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue
    cluster.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    const total =
      cluster.reduce((s, it) => s + it.h, 0) + EDGE_LABEL_GAP * (cluster.length - 1)
    const first = cluster[0]!
    const last = cluster[cluster.length - 1]!
    const center = (first.cy + last.cy) / 2
    let y = center - total / 2
    for (const it of cluster) {
      it.cy = y + it.h / 2
      y += it.h + EDGE_LABEL_GAP
    }
  }

  // 障碍物避让：排开后的标签（含未碰撞的单标签）不能压节点框、
  // 也不能横跨子图边框（半进半出时边框线会切过文字）。整簇一起
  // 水平推移，保持簇内已排开的纵向间距。
  interface Box {
    x1: number
    y1: number
    x2: number
    y2: number
    hollow: boolean
  }
  const obstacles: Box[] = []
  const nodeEls = [
    ...svg.querySelectorAll<SVGGElement>('g.node'),
    ...svg.querySelectorAll<SVGGElement>('g.cluster'),
  ]
  for (const el of nodeEls) {
    const bb = el.getBBox()
    if (!bb.width || !bb.height) continue
    const tm = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/.exec(
      el.getAttribute('transform') ?? '',
    )
    const tx = tm ? +tm[1]! : 0
    const ty = tm ? +tm[2]! : 0
    obstacles.push({
      x1: tx + bb.x,
      y1: ty + bb.y,
      x2: tx + bb.x + bb.width,
      y2: ty + bb.y + bb.height,
      // 子图是空心的：标签完全落在其内部（不碰边框、不碰节点）是允许的
      hollow: el.classList.contains('cluster'),
    })
  }
  interface Rect {
    x1: number
    y1: number
    x2: number
    y2: number
  }
  const overlaps = (s: Rect, o: Rect) =>
    s.x1 < o.x2 && s.x2 > o.x1 && s.y1 < o.y2 && s.y2 > o.y1
  const contains = (o: Rect, s: Rect) =>
    s.x1 >= o.x1 && s.x2 <= o.x2 && s.y1 >= o.y1 && s.y2 <= o.y2

  for (const cluster of clusters.values()) {
    for (let round = 0; round < 4; round++) {
      const x1 = Math.min(...cluster.map((it) => it.cx - it.w / 2))
      const x2 = Math.max(...cluster.map((it) => it.cx + it.w / 2))
      const y1 = Math.min(...cluster.map((it) => it.cy - it.h / 2))
      const y2 = Math.max(...cluster.map((it) => it.cy + it.h / 2))
      let dx = 0
      for (const o of obstacles) {
        if (!overlaps({ x1, y1, x2, y2 }, o)) continue
        if (o.hollow && contains(o, { x1, y1, x2, y2 })) continue
        // 候选位移：推到障碍物左侧/右侧外；空心（子图）还可以完全退进去
        const candidates: number[] = [o.x2 + EDGE_OBSTACLE_GAP - x1, o.x1 - EDGE_OBSTACLE_GAP - x2]
        if (o.hollow && y1 >= o.y1 && y2 <= o.y2 && x2 - x1 <= o.x2 - o.x1 - 2 * EDGE_OBSTACLE_GAP) {
          candidates.push((o.x2 - EDGE_OBSTACLE_GAP) - x2, (o.x1 + EDGE_OBSTACLE_GAP) - x1)
        }
        const pick = candidates.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a))
        if (dx === 0 || Math.abs(pick) > Math.abs(dx)) dx = pick
      }
      if (dx === 0) break
      for (const it of cluster) it.cx += dx
    }
  }

  // 一次性写回 transform
  for (const it of items) {
    it.el.setAttribute('transform', `translate(${it.cx}, ${it.cy})`)
  }
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
      renderEl.addEventListener('mousedown', ((e: MouseEvent) => {
        if (editing) return
        e.preventDefault()
        const { clientX, clientY } = e
        enterEdit()
        // 光标落到点击处（Typora 行为）：视图切换后需两帧（class 生效 + 布局稳定）
        // 再按坐标定位；定位失败回落块首
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const hit = view.posAtCoords({ left: clientX, top: clientY })
            if (hit) {
              view.focus()
              // 统一用 hit.pos（精确字符位置）；hit.inside 是节点内部起点，
              // 命中非叶子时会抢先导致光标落到块首
              const $pos = view.state.doc.resolve(hit.pos)
              view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
            } else {
              focusNode(view, getPos)
            }
          })
        })
      }) as EventListener)
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
      copyTextToClipboard(node.textContent)
      copyBtn.textContent = '已复制'
      copyBtn.classList.add('copied')
      setTimeout(() => {
        copyBtn.textContent = '复制'
        copyBtn.classList.remove('copied')
      }, 2000)
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
    clickToEdit: true,
    render(source, renderEl, node) {
      const lang = String(node.attrs['language'] ?? '')
      if (lang === 'mermaid') {
        renderEl.classList.add('mermaid')
        renderEl.innerHTML = '图表生成中…'
        const id = `mf-mermaid-${Math.random().toString(36).slice(2, 9)}`
        // 渲染+回填+清理整体入队：清理若排在队列外，会删掉已开始的下一个
        // render 的临时容器（mermaid 内部 fit 随即 firstChild of null）
        return serializeMermaidRender(async () => {
          try {
            const m = await getMermaid()
            // 字体就绪后再渲染：gantt/时间线类图的布局依赖 mermaid 内部的文本
            // 宽度测量（getBBox），webfont 未就绪时按 fallback 度量布局会导致
            // 文字挤压/溢出（不同主题字体及加载延迟不同，故问题程度不一）
            await document.fonts.ready
            // gantt 布局宽跟随容器（默认 300px 文字挤爆；串行队列内重复 initialize 安全）
            const cw = renderEl.clientWidth || renderEl.parentElement?.clientWidth || 640
            ;(m as unknown as MermaidInit).initialize({
              ...mermaidConfig(),
              gantt: { useWidth: Math.max(300, Math.round(cw)) },
            })
            const { svg } = await m.render(id, source)
            renderEl.innerHTML = svg
            deoverlapEdgeLabels(renderEl)
          } catch (err) {
            renderEl.innerHTML = `<div class="mf-render-error">Mermaid 图表有误：${
              (err as Error)?.message ?? err
            }</div>`
          } finally {
            // 队列内此刻无其他 render 在途，body 直下的 mermaid 容器必是
            // 历史/本次残留——按前缀全清（防逃逸挤占排版）
            for (const leftover of document.querySelectorAll(
              'body > [id^="dmf-mermaid-"], body > [id^="mf-mermaid-"]',
            )) {
              leftover.remove()
            }
          }
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

/** 剪贴板复制：clipboard API 优先 + execCommand 兜底（iframe / 无焦点场景） */
function copyTextToClipboard(text: string): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {
      execCommandCopy(text)
    })
  } else {
    execCommandCopy(text)
  }
}

function execCommandCopy(text: string): void {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
}
