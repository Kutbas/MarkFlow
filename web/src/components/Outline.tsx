import { useEffect, useState } from 'react'
import { useApp } from '../store'
import { getPMView } from './pm-view'

/** 大纲文本中的常见 LaTeX 命令转 Unicode 符号（标题含行内公式时，
 *  大纲无法跑完整排版，用符号近似显示代替源码） */
const LATEX_SYMBOLS: Array<[RegExp, string]> = [
  [/\\lambda/g, 'λ'], [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'],
  [/\\delta/g, 'δ'], [/\\epsilon/g, 'ε'], [/\\theta/g, 'θ'], [/\\pi/g, 'π'],
  [/\\sigma/g, 'σ'], [/\\mu/g, 'μ'], [/\\phi/g, 'φ'], [/\\omega/g, 'ω'],
  [/\\times/g, '×'], [/\\cdot/g, '·'], [/\\leq/g, '≤'], [/\\geq/g, '≥'],
  [/\\neq/g, '≠'], [/\\approx/g, '≈'], [/\\infty/g, '∞'], [/\\sum/g, '∑'],
  [/\\left|\\right/g, ''], [/\\text\{([^}]*)\}/g, '$1'], [/\\mathbf\{([^}]*)\}/g, '$1'],
]

export function formatOutlineText(text: string): string {
  let out = text
  for (const [re, rep] of LATEX_SYMBOLS) out = out.replace(re, rep)
  return out
}

export interface OutlineItem {
  level: number
  text: string
  /** 顶层标题序号（跳转按序定位，避免文本匹配因行内格式失配/重复标题跳错） */
  index: number
}

/** 折叠键：level|text（数据源无节点 id，文本键在编辑/渐进更新下保持稳定；
 *  同级同文的重复标题会一起折叠——可接受的折中） */
export function outlineKey(item: OutlineItem): string {
  return `${item.level}|${item.text}`
}

/**
 * 大纲可见性计算：折叠某标题后，其后所有 level 更深的标题被隐藏，
 * 直到出现 level 不深于它的标题。支持嵌套折叠（按序扫描）。
 * 返回可见项的原始索引数组。
 */
export function visibleOutlineIndexes(
  outline: OutlineItem[],
  collapsedKeys: ReadonlySet<string>,
): number[] {
  const out: number[] = []
  let hideBelow = 0 // >0 时隐藏 level >= hideBelow 的标题
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i]!
    if (hideBelow > 0 && item.level >= hideBelow) continue
    hideBelow = 0
    out.push(i)
    if (collapsedKeys.has(outlineKey(item))) hideBelow = item.level + 1
  }
  return out
}

/** 标题 i 是否有子级（其后紧跟更深标题） */
export function outlineHasChildren(outline: OutlineItem[], i: number): boolean {
  return i + 1 < outline.length && outline[i + 1]!.level > outline[i]!.level
}

/** 文档大纲：点击跳转到对应标题（按标题文本匹配 DOM），标题可折叠隐藏子级；
 *  activeMatchIndex = 侧栏搜索的当前命中（顶层标题序号），变化时跳转并高亮 */
export function Outline({ activeMatchIndex = -1 }: { activeMatchIndex?: number }) {
  const outline = useApp((s) => s.outline)
  const currentPath = useApp((s) => s.currentPath)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [activeHeading, setActiveHeading] = useState(-1)

  // 高亮项不在大纲可视区时自动滚动，锚定在列表中间（平滑滚动，同编辑区跳转手感）
  useEffect(() => {
    if (activeHeading < 0) return
    document
      .querySelector('.outline-item.active')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeHeading])

  // 当前光标所属标题：节流监听选区变化，取光标前最近顶层标题的序号（高亮侧边栏）
  useEffect(() => {
    let timer = 0
    const update = () => {
      const view = getPMView() as
        | {
            state?: {
              selection: { from: number }
              doc: unknown
            }
          }
        | null
      const from = view?.state?.selection?.from
      const doc = view?.state?.doc as
        | {
            forEach: (f: (n: { type: { name: string }; nodeSize: number }) => void) => void
          }
        | undefined
      if (typeof from !== 'number' || !doc) return
      let seq = -1
      let active = -1
      let offset = 0
      doc.forEach((n) => {
        if (n.type.name === 'heading') {
          seq++
          if (offset < from) active = seq
        }
        offset += n.nodeSize
      })
      setActiveHeading(active)
    }
    const onSel = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(update, 200)
    }
    document.addEventListener('selectionchange', onSel)
    update()
    return () => {
      document.removeEventListener('selectionchange', onSel)
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath])

  /** 按顶层标题序号跳转（ProseMirror 直接子级的 heading 顺序与协同树顶层一致，
   *  无文本歧义；嵌套在引用等容器内的标题不计入序号）。
   *  placeCursor=false 时只滚动不高亮光标——搜索导航用：移动 DOM selection
   *  会把焦点/后续键入抢进编辑区（用户正在搜索框打字，绝不能动文档光标） */
  const jump = (index: number, placeCursor = true) => {
    const pm = document.querySelector('.ProseMirror')
    if (!pm) return
    const headings = pm.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')
    const h = headings[index]
    if (!h) return
    h.scrollIntoView({ behavior: 'smooth', block: 'start' })
    h.animate?.([{ background: 'rgba(80,123,108,.25)' }, { background: 'none' }], {
      duration: 1200,
    })
    if (!placeCursor) return
    // 光标落进标题 → selectionchange → 大纲高亮自动切换（跳转与高亮一体两面）
    try {
      const r = document.createRange()
      r.selectNodeContents(h)
      r.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    } catch { /* DOM selection 失败不影响滚动跳转 */ }
  }

  // 侧栏搜索命中变化：编辑区跳转到该标题——只滚动，不动文档光标
  //（搜索框正在输入，selection 移动会把键入抢进编辑区误改文档）
  useEffect(() => {
    if (activeMatchIndex >= 0) jump(activeMatchIndex, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMatchIndex, currentPath])

  const toggle = (item: OutlineItem) => {
    const key = outlineKey(item)
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (!currentPath) return <div className="outline-empty">未打开文档</div>
  if (outline.length === 0)
    return <div className="outline-empty">文档暂无标题</div>

  const visible = visibleOutlineIndexes(outline, collapsed)

  return (
    <div className="outline-list">
      {visible.map((i) => {
        const item = outline[i]!
        const hasKids = outlineHasChildren(outline, i)
        return (
          <div
            key={i}
            className={`outline-item ${i === activeHeading ? 'active' : ''} ${outline[i]!.index === activeMatchIndex ? 'search-hit' : ''}`}
            style={{ paddingLeft: (item.level - 1) * 12 + 10 }}
            onClick={() => jump(item.index)}
            title={item.text}
          >
            <span
              className={`outline-caret ${hasKids ? '' : 'leaf'}`}
              onClick={(e) => {
                e.stopPropagation()
                if (hasKids) toggle(item)
              }}
            >
              {hasKids ? (collapsed.has(outlineKey(item)) ? '▸' : '▾') : ''}
            </span>
            <span className="outline-h">H{item.level}</span>
            <span className="outline-text">{formatOutlineText(item.text)}</span>
          </div>
        )
      })}
    </div>
  )
}
