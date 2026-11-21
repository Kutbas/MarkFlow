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
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
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

/** 拖选经过代码区期间挂起/恢复 PM 的 DOM 观察器：焦点在渲染层（非
 *  contentDOM）时 SelectionReader 会把选区映射成块边界并 dispatch，
 *  updateState 的防重写守卫在 reader 异步 flush 与指针移动的竞态窗口
 *  下偶发失效——边界选区被 selectionToDOM 写回 DOM，整块选区闪现又
 *  消失（用户实测"抽搐"）。挂起观察器（reader 与 MutationObserver 都
 *  挂其上）= 无 flush = 无重写路径；纯选区拖选期间无文档变更，无副
 *  作用。PM 内部 API，防御式判空 */
function suspendPMDomObserver(view: EditorView): void {
  ;(view as unknown as { domObserver?: { stop(): void } }).domObserver?.stop()
}
function resumePMDomObserver(view: EditorView): void {
  ;(view as unknown as { domObserver?: { start(): void } }).domObserver?.start()
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
  /** WYSIWYG 形态：重拷编辑层 inline 样式（主题切换后重同步） */
  sync?: () => void
}
const viewRegistry = new WeakMap<HTMLElement, ToggleController>()
const editingControllers = new Set<ToggleController>()

/** 正在渲染层首次按压（原生拖选中）的视图：此期间 selectionchange 不触发
 *  enter——层叠翻转（渲染层转 pointer-events:none）会打断原生选区的
 *  锚定与扩展，mouseup 后统一转换 */
let renderPressEl: HTMLElement | null = null

function onDocSelectionChange(): void {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const toToggleEl = (n: Node | null): HTMLElement | null => {
    const el = n instanceof Element ? n : (n?.parentElement ?? null)
    return (el?.closest('.mf-toggle-view') as HTMLElement | null) ?? null
  }
  const anchorEl = toToggleEl(sel.anchorNode)
  const focusEl = toToggleEl(sel.focusNode)
  // 保持判定看选区两端：跨块拖选（锚在正文、焦点在代码 contentDOM 内）
  // 时已编辑视图不被踢出——只看锚点会把选区焦点从 contentDOM 拔出，
  // 选区被重映射到块边界（整块选中/部分内容被排斥）
  const stayEls = new Set<HTMLElement>()
  for (const el of [anchorEl, focusEl]) {
    if (el) stayEls.add(el)
  }
  for (const ctrl of [...editingControllers]) {
    if (!stayEls.has(ctrl.el)) ctrl.leave()
  }
  // 进入判定仅折叠光标（锚端所在视图，Typora 点击进入源码语义）：拖选
  // 路过（非折叠）绝不触发——enter 翻转层叠会打断原生延伸，且 PM 会把
  // 边界映射的选区写进刚显形的编辑层，与渲染层原生选区叠出整块第二
  // 选区（119 轮回归，用户实测）
  if (!sel.isCollapsed) return
  if (renderPressEl && anchorEl === renderPressEl) return
  if (anchorEl) viewRegistry.get(anchorEl)?.enter()
}

// 点击编辑器之外（侧栏/顶栏）：清空所有编辑态（Typora 行为）
function onDocPointerDown(e: Event): void {
  const target = e.target as Element | null
  if (target?.closest?.('.ProseMirror')) return
  for (const ctrl of [...editingControllers]) ctrl.leave()
}

/** 主题切换后重同步编辑中代码块的叠层样式：编辑层的 inline 值拷自旧主题
 *  的 computed，切主题后不再与渲染层（新主题）一致（编辑中切主题产生
 *  ~1px 横差的边缘问题）。遍历编辑中控制器重拷即可——由 MilkdownEditor
 *  在 theme 变化后一帧调用（等新主题 CSS 应用） */
export function syncEditingWysiwygStyles(): void {
  for (const ctrl of editingControllers) ctrl.sync?.()
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
  /** 源码编辑区做成主题 fences（pre.md-fences）：与渲染态同源同外观，
   *  编辑切换无视觉突变——普通代码块用；mermaid/公式保留虚线切换提示 */
  sourceAsFences?: (node: PMNode) => boolean
}): (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  const { className, render } = options
  return (node, view, getPos) => {
    let currentNode = node
    const tag = options.inline ? 'span' : 'div'
    const dom = document.createElement(tag)
    dom.className = `mf-toggle-view ${className}`
    const renderEl = document.createElement(tag)
    renderEl.className = 'mf-render'
    const asFences = options.sourceAsFences?.(node) ?? false
    if (asFences) dom.classList.add('mf-wysiwyg') // 编辑态渲染层常显（叠层）的形态标记
    const srcEl = document.createElement(asFences ? 'pre' : tag)
    srcEl.className = asFences ? 'mf-source md-fences' : 'mf-source'
    if (asFences) {
      // 行号列与渲染层同规则：普通代码恒有（单行也显示行号 1，缩进一致）
      srcEl.classList.add('mf-lineno')
    }
    dom.appendChild(renderEl)
    dom.appendChild(srcEl)

    let editing = false
    let renderToken = 0
    /** rAF 合并标记：连续输入只在一帧内重渲染一次（WYSIWYG 叠层的底层刷新） */
    let refreshQueued = false
    const scheduleRefresh = () => {
      if (refreshQueued) return
      refreshQueued = true
      requestAnimationFrame(() => {
        refreshQueued = false
        void refresh()
      })
    }

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

    /** WYSIWYG 叠层的编辑层同步：逐属性拷贝自渲染层 pre。
     *  inline 值压一切主题特异性——盒模型/字体与渲染层 computed 同源，
     *  任何主题（含未来新增）下两层自动一致，无需逐主题 CSS 对抗；
     *  机制属性（背景/文字透明）inline 写死（叠层机制的一部分）。
     *  font 简写的 computed 值在子属性非默认时返回空串（简写赋值无效），
     *  必须逐属性。 */
    const SYNC_PROPS = [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'letterSpacing',
      'marginTop',
      'marginRight',
      'marginBottom',
      'marginLeft',
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
    ] as const
    const syncWysiwygStyles = () => {
      try {
        const pre = renderEl.querySelector('pre')
        if (pre) {
          const cs = getComputedStyle(pre)
          for (const prop of SYNC_PROPS) srcEl.style[prop] = cs[prop]
          // 行高从行元素取：pre 自身的 line-height 是主题值，渲染层每行
          // 实际高度由 .mf-cl 的 1.6 规则决定——拷 pre 值会让编辑层逐行
          // 纵向累积错位（选框与文字不对齐）+ 总高差（底部多一块）
          const cl = renderEl.querySelector('.mf-cl')
          srcEl.style.lineHeight = getComputedStyle(cl ?? pre).lineHeight
        }
        srcEl.style.background = 'transparent'
        srcEl.style.color = 'transparent'
      } catch (e) {
        console.warn('[mf] 编辑层样式同步失败：', e)
      }
    }
    const enterEdit = () => {
      if (editing) return
      editing = true
      dom.classList.add('editing')
      if (asFences) syncWysiwygStyles()
      const ctrl = controller
      if (ctrl) editingControllers.add(ctrl)
    }
    const leaveEdit = () => {
      if (!editing) return
      editing = false
      dom.classList.remove('editing')
      if (asFences) {
        for (const prop of SYNC_PROPS) srcEl.style[prop] = ''
        srcEl.style.lineHeight = ''
        srcEl.style.background = ''
        srcEl.style.color = ''
      }
      const ctrl = controller
      if (ctrl) editingControllers.delete(ctrl)
      void refresh()
    }

    const controller: ToggleController = { el: dom, enter: enterEdit, leave: leaveEdit }
    if (asFences) controller.sync = syncWysiwygStyles
    viewRegistry.set(dom, controller)
    ensureDispatch()

    if (options.clickToEdit) {
      // 光标落到点击处（Typora 行为）：视图切换后需两帧（class 生效 + 布局稳定）
      // 再按坐标定位；定位失败回落块首
      const placeCaret = (clientX: number, clientY: number) => {
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
      }
      // 外部拖选路过（按压在正文、指针进入代码区）：渲染层文本不是 PM
      // contentDOM，原生选区焦点落在其上会被 PM 映射到块边界（松开时整块
      // 选中/部分内容被排斥）。不能中途翻转层叠——原生选区的延伸会在层
      // 切换时停摆（实测焦点冻结在进入块那一刻，同 115 轮锚定教训）。
      // 改为 mouseup 统一转换：按压期原生拖选完整进行，松开时若有端点
      // 落在本层，取端点矩形 → enterEdit → posAtCoords 映射两端 →
      // 精确 PM 选区（选区停在光标处）。锚点在本层内的按压走 115 轮路径
      // （mousedown 上已挂转换），此处只管外部发起的拖选
      if (asFences) {
        renderEl.addEventListener('mouseenter', () => {
          if (editing) return
          const sel = document.getSelection()
          if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
          if (sel.anchorNode && renderEl.contains(sel.anchorNode)) return
          // 挂起 PM DOM 观察（整块闪现竞态，见 suspendPMDomObserver 注释）；
          // mouseup 先恢复再转换
          suspendPMDomObserver(view)
          document.addEventListener(
            'mouseup',
            () => {
              resumePMDomObserver(view)
              const s = document.getSelection()
              if (!s || s.isCollapsed || s.rangeCount === 0) return
              if (!s.focusNode || !renderEl.contains(s.focusNode)) return // 拖选已离开本层
              const rects = s.getRangeAt(0).getClientRects()
              const first = rects[0]
              const last = rects[rects.length - 1]
              enterEdit()
              srcEl.getBoundingClientRect() // 强制布局：contentDOM 刚显形
              const at = (rect: DOMRect | undefined, side: 'left' | 'right') =>
                rect && view.posAtCoords({ left: side === 'left' ? rect.left + 1 : rect.right - 1, top: (rect.top + rect.bottom) / 2 })
              const a = at(first, 'left')
              const b = at(last, 'right')
              if (a && b) {
                view.focus()
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.between(view.state.doc.resolve(a.pos), view.state.doc.resolve(b.pos)),
                  ),
                )
              }
            },
            { once: true },
          )
        })
      }
      renderEl.addEventListener('mousedown', ((e: MouseEvent) => {
        if (editing) return
        const { clientX, clientY } = e
        if (!asFences) {
          // mermaid/公式（无 contentDOM 常显形态）：渲染结果是 SVG/公式，
          // 原生选择无意义——拦截默认，进编辑后光标落位
          e.preventDefault()
          enterEdit()
          placeCaret(clientX, clientY)
          return
        }
        // fences WYSIWYG：不 preventDefault，按压期间也不翻转层叠——
        // 原生拖选/点击直接在静态渲染层文本上进行（首次拖选即生效，
        // 含原生 autoscroll；此前无条件 preventDefault 导致"第一次拖选
        // 无反应，再拖一次才能选"）。mouseup 后统一转换进编辑态：
        // 拖选 → 端点坐标映射为 contentDOM 内的 PM 选区；纯点击 → 光标落位。
        // 拖选期间挂起 PM DOM 观察（reader 边界映射的防重写竞态，整块
        // 选区闪现——同 mouseenter 路径），mouseup 先恢复
        renderPressEl = dom
        suspendPMDomObserver(view)
        document.addEventListener(
          'mouseup',
          () => {
            renderPressEl = null
            resumePMDomObserver(view)
            const sel = document.getSelection()
            if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.anchorNode && renderEl.contains(sel.anchorNode)) {
              // 拖选：先在静态渲染层上取端点矩形（视口坐标），再进编辑态
              // （层叠几何重合，坐标仍有效）后映射为文档位置
              const rects = sel.getRangeAt(0).getClientRects()
              const first = rects[0]
              const last = rects[rects.length - 1]
              enterEdit()
              srcEl.getBoundingClientRect() // 强制布局：contentDOM 刚显形
              const at = (rect: DOMRect | undefined, side: 'left' | 'right') =>
                rect && view.posAtCoords({ left: side === 'left' ? rect.left + 1 : rect.right - 1, top: (rect.top + rect.bottom) / 2 })
              const a = at(first, 'left')
              const b = at(last, 'right')
              if (a && b) {
                view.focus()
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.between(view.state.doc.resolve(a.pos), view.state.doc.resolve(b.pos)),
                  ),
                )
                return
              }
            }
            enterEdit()
            placeCaret(clientX, clientY)
          },
          { once: true },
        )
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
        // WYSIWYG 叠层（sourceAsFences）：编辑中也刷新渲染层——底层重绘
        // 不触碰 contentDOM，用户看到的高亮/行号随输入实时更新；
        // 虚线切换类（mermaid/公式）保持编辑中不刷新（渲染层隐藏，白跑）
        if (changed) {
          if (asFences) scheduleRefresh()
          else if (!editing) void refresh()
        }
        return true
      },
      ignoreMutation: (mutation) => {
        const target = mutation.target as HTMLElement
        // 渲染区与自身的属性/结构切换不属于文档变化，必须屏蔽，
        // 否则 PM 的 MutationObserver 会把这些 DOM 写入当作内容变化重新解析
        if (renderEl.contains(target)) return true
        if (target === dom && mutation.type === 'attributes') return true
        // 编辑层自身的 style 属性（WYSIWYG 进入编辑时的字体拷贝）同样
        // 不是内容变化——曾致 PM 重建 NodeView，编辑态进一次丢一次
        if (target === srcEl && mutation.type === 'attributes' && mutation.attributeName === 'style') return true
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
    // 普通代码：源码区即主题 fences（编辑态与渲染态无缝）；mermaid 保留虚线
    sourceAsFences: (node) => String(node.attrs['language'] ?? '') !== 'mermaid',
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

      // 行号：逐行切分 + CSS counter（一行代码一行行号同容器，结构性对齐零漂移）。
      // 单行同样走行结构（行号 1 + 行号列缩进）——曾按 lines>1 分支致单行块
      // 无行号且起点比多行靠左（宽度不一致，用户实测）；mermaid 已提前 return
      const lines = source.split('\n')
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

    let selected = false
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
      const pos = getPos()
      // 清空后失焦/回车 = 删除图片（编辑框内自然的删除路径）
      if (v === '' && typeof pos === 'number') {
        view.dispatch(view.state.tr.delete(pos, pos + currentNode.nodeSize))
        return
      }
      // 解析 ![alt](url)
      const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(v)
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
    // Typora 行为：单击 = 选中整图（Backspace/Delete 直接删除、输入字符替换）；
    // 已选中再点（或双击）= 进入源码编辑框；编辑框清空后确认 = 删除
    img.addEventListener('mousedown', (e) => {
      if (dom.classList.contains('editing')) return
      e.preventDefault()
      if (selected) {
        enterEdit()
        return
      }
      const pos = getPos()
      if (typeof pos === 'number') {
        view.focus()
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
      }
    })

    renderImg()

    return {
      dom,
      selectNode() {
        selected = true
        dom.classList.add('mf-image-selected')
      },
      deselectNode() {
        selected = false
        dom.classList.remove('mf-image-selected')
      },
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
