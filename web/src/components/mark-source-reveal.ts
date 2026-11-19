/**
 * 标记源码展开（Typora 本质模型）：光标进入/紧邻标记区域（加粗/斜体/
 * 删除线/行内代码/超链接）时，把区域"展开"为字面源码——`**MM**` 的符号
 * 变成真实文本字符：光标可停靠在任意符号前后（原生字符导航）、删除任意
 * 符号是原生字符删除（Typora"删一个 * 加粗消失、其余保留"）。
 * 超链接同机制：点击进入展开为 `[文本](地址)` 字面，改字面 URL 即改链接。
 * 光标离开展开区时"合拢"：符号序列完好 → 恢复渲染态；被改动过（删了
 * 符号等）→ 保持字面文本不动。
 * 多标记叠加按固定顺序拼接（加粗+斜体 = ***，加粗+链接 = **[x](u)**）。
 * 整跨展开（span）：区域按"标记名交集"取整跨生长——混合标记段（如加粗
 * 内嵌行内代码）光标进入即显示整跨源码 `**1. \`MicroLIB\` …**`（Typora
 * 行为）；字面内层由 serializer 现算，合拢经 parser 重解析精确还原。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode, Fragment } from '@milkdown/kit/prose/model'
import { getPMParser, getPMSerializer } from './pm-view'

/** 标记 → 语法符号（拼接顺序即多标记时的组合顺序）；link 无对称符号，
 *  语法是 [内容](href) 结构——只参与排序（最内层）不进符号表 */
const MARK_ORDER = ['strong', 'emphasis', 'strike_through', 'inlineCode', 'link'] as const
export const LINK_NAME = 'link'
const MARK_SYNTAX: Record<string, string> = {
  strong: '**',
  emphasis: '*',
  strike_through: '~~',
  inlineCode: '`',
}

export const markSourceRevealKey = new PluginKey('mfMarkSourceReveal')

export interface Revealed {
  /** 展开区（字面 `语法+内容+语法`）的文档范围 */
  from: number
  to: number
  /** 展开时的语法符号序列（如 '**' / '***'），合拢时校验用 */
  syntax: string
  /** 展开时的标记名单——合拢按名单还原（不能由 syntax 反推：
   *  '**'.includes('*') 误命中 emphasis，合拢即污染成加粗+斜体） */
  markNames: string[]
  /** 整跨区：markNames 是区域内各节点的公共标记（交集），内层含其它
   *  标记（如加粗内嵌代码）——字面内层是 markdown 源码，合拢/消解必须
   *  走重解析而非按名单平铺 */
  span?: boolean
}

/** 区域内全部文本的标记集合是否一致（只展开标记齐整的区域） */
function uniformMarks(node: PMNode, from: number, to: number): string[] | null {
  const box: { key?: string } = {}
  let uniform = true
  node.nodesBetween(from, to, (n) => {
    if (!n.isText || !uniform) return
    const key = n.marks.map((m) => m.type.name).sort().join(',')
    if (box.key === undefined) box.key = key
    else if (box.key !== key) uniform = false
  })
  if (!uniform || box.key === undefined) return null
  const names = box.key.split(',').filter(Boolean)
  return names.length > 0 && names.every((n) => MARK_SYNTAX[n] !== undefined || n === LINK_NAME) ? names : null
}

/** 标记名单 → 语法符号串（固定顺序拼接，link 只提供排序不产符号）——
 *  keymap 展开感知分支复用 */
export function syntaxOf(markNames: string[]): string {
  return MARK_ORDER.filter((m) => m !== LINK_NAME && markNames.includes(m))
    .map((m) => MARK_SYNTAX[m])
    .join('')
}

export interface RevealedLiteral {
  content: string
  /** link 在场时的链接地址（从字面解析，改字面即改链接） */
  href?: string
}

/** 闭合定界 = 开定界的字符反序：嵌套组合的合法 markdown 形态
 *  （['strong','inlineCode'] 开 `**\`` 闭 `` \`** `` → `**\`x\`**`）；
 *  此前同序拼接产出 `**\`x**\`` 非法嵌套，且定界符间一旦插入文本
 *  （如 `**1. \`x\`**`）就无法被严格校验识别，被误判破形永久滞留字面 */
function closeSyntax(s: string): string {
  return [...s].reverse().join('')
}

/** markNames + 内容 → 字面源码（link 在场：符号包着 [内容](href)） */
export function buildLiteral(markNames: string[], content: string, href?: string): string {
  const inner = markNames.includes(LINK_NAME) ? `[${content}](${href ?? ''})` : content
  const s = syntaxOf(markNames)
  return s + inner + closeSyntax(s)
}

/** 字面源码 → 内容/地址（展开区完好性校验与合拢取参共用）：
 *  先剥外层符号（闭合为反序）；link 在场再匹配 [内容](href)——贪婪到
 *  最后一个 ')'，href 内含 '(' 的罕见 URL 判破形（与 CommonMark 语法同限） */
export function parseRevealed(text: string, syntax: string, hasLink: boolean): RevealedLiteral | null {
  const close = closeSyntax(syntax)
  if (text.length < syntax.length + close.length || !text.startsWith(syntax) || !text.endsWith(close)) return null
  const body = text.slice(syntax.length, text.length - close.length)
  if (!hasLink) return { content: body }
  const m = /^\[([\s\S]*)\]\(([\s\S]*)\)$/.exec(body)
  if (!m) return null
  return { content: m[1]!, href: m[2]! }
}

/** 严格校验失败后的宽限重解析：定界符之间被插入文本（如 `**1. \`x\`**`，
 *  "1. " 插在 ** 与 ` 之间）不是破形——Typora 把展开源码当 markdown
 *  文本编辑，光标离开即重新解析渲染。用编辑器同 schema 的 parser 重解，
 *  结果为单段且全部文本带格式 mark 才接受（出现无标记残留 = 真破形，
 *  保持字面，维持"删一个 * 加粗消失、剩余符号保留"的既有语义）。
 *  整跨区（span）合拢也走此路：字面内层本就是混合标记的 markdown。 */
export function reparseAsMarkdown(literal: string, requireMarks = true): Fragment | null {
  const parse = getPMParser() as ((md: string) => PMNode) | null
  if (!parse) return null
  // 行首列表记号转义：本函数按"行内片段"解读传入文本（消解场景内层如
  // "1. `x` …"），裸解析会把开头的 "1. "/"- " 当块级列表标记吞掉
  const guarded = literal
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, '$1$2\\$3$4')
    .replace(/^(\s*)([-*+])(\s)/, '$1\\$2$3')
  let doc: PMNode
  try {
    doc = parse(guarded + '\n')
  } catch {
    return null
  }
  const para = doc.firstChild
  if (!para || doc.childCount !== 1 || para.type.name !== 'paragraph') return null
  let hasText = false
  let allMarked = true
  para.content.forEach((n) => {
    if (!n.isText || !n.text) return
    hasText = true
    if (n.marks.length === 0) allMarked = false
  })
  if (!hasText) return null
  // requireMarks=false：消解场景（去掉外层格式）内层本就该有无标记文本
  return requireMarks ? (allMarked ? para.content : null) : para.content
}

/** 展开区合拢为渲染态（appendTransaction 的离开合拢与 keymap 展开区内
 *  子选区格式化共用）：按展开时记录的名单还原标记（syntax 反推会误命中：
 *  '**'.includes('*')）、link 按字面解析出的 href 重建（改字面 URL = 改
 *  链接地址），并清掉 revealed 状态。返回内容在字面中的前缀长度
 *  （符号串 + link 在场时的 '['），供调用方做选区坐标换算。 */
export function collapseRevealed(
  tr: Transaction,
  schema: EditorState['schema'],
  r: Revealed,
  parsed: RevealedLiteral,
): number {
  const marks = r.markNames
    .map((n) =>
      n === LINK_NAME
        ? schema.marks[n]?.create({ href: parsed.href ?? '' })
        : schema.marks[n]?.create(),
    )
    .filter(Boolean)
  tr.replaceWith(r.from, r.to, schema.text(parsed.content, marks as never))
  tr.setMeta(markSourceRevealKey, { revealed: null })
  return r.syntax.length + (r.markNames.includes(LINK_NAME) ? 1 : 0)
}

/** 整跨区内容 → markdown 源码（字面内层）：剥掉公共标记（由字面自身的
 *  定界符代表）后用编辑器 serializer 序列化（包一层段落，去尾换行）——
 *  内层其它标记（如内嵌代码的反引号）以源码形态呈现。serializer 不可
 *  用（测试外未接线）返回 null，调用方退回不展开。 */
function serializeSpanInner(fragment: Fragment, schema: EditorState['schema'], stripNames: string[]): string | null {
  const ser = getPMSerializer()
  if (!ser) return null
  try {
    const stripped: PMNode[] = []
    fragment.forEach((n) => {
      stripped.push(
        n.isText ? n.mark(n.marks.filter((m) => !stripNames.includes(m.type.name))) : n,
      )
    })
    const paraType = schema.nodes.paragraph
    if (!paraType) return null
    const para = paraType.create(null, stripped)
    const md = ser(schema.topNodeType.create(null, para))
    return md.replace(/\n+$/, '')
  } catch {
    return null
  }
}

/** 光标是否仍在展开构造体内（含两端）——[from, to]：停在符号上/之间/紧贴
 *  符号内侧（a/b/c/d 四位）都算交互中；移出一位即离开（Typora：出符号即合拢）。
 *  此前 [from-1, to+1] 过宽：光标停在符号后一位（用户认知的"已移出"）不合拢 */
function selectionNear(state: EditorState, from: number, to: number): boolean {
  const { from: f, to: t } = state.selection
  return f >= from && f <= to && t >= from && t <= to
}

/** 集合交集（b 为数组形式） */
function intersect(a: Set<string>, b: string[]): Set<string> {
  return new Set([...a].filter((x) => b.includes(x)))
}

/** 找光标紧邻/所在的标记区域（a/b/c/d 四位或区内）：交集取整——
 *  从光标相邻/所在文本节点向两侧生长到"标记名交集非空且不含 link"的
 *  极限（Typora 整跨展开：加粗内嵌代码的句子整体显示源码）。节点标记
 *  集完全相等 → 经典区域（行为同旧模型）；混合 → span 区域（需
 *  serializer 生成字面内层，否则不展开）。 */
function regionAt(
  state: EditorState,
): { from: number; to: number; markNames: string[]; href: string; span?: boolean } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const parent = $from.parent
  const parentStart = $from.pos - $from.parentOffset
  const pos = $from.pos

  // 光标紧邻/所在的文本子节点（种子）
  const kids: Array<{ n: PMNode; off: number }> = []
  parent.forEach((n, off) => kids.push({ n, off }))
  const names = (n: PMNode): string[] => n.marks.map((m) => m.type.name)
  const seeds: number[] = []
  kids.forEach(({ n, off }, i) => {
    if (!n.isText || n.marks.length === 0) return
    const absFrom = parentStart + off
    const absTo = absFrom + n.nodeSize
    if (pos === absFrom || pos === absTo || (pos > absFrom && pos < absTo)) seeds.push(i)
  })
  if (seeds.length === 0) return null

  // 种子交集 → 向两侧生长（交集非空且不含 link 才延伸）
  const firstSeed = seeds[0] as number
  const lastSeed = seeds[seeds.length - 1] as number
  let inter = new Set(names(kids[firstSeed]!.n))
  for (let k = 1; k < seeds.length; k++) inter = intersect(inter, names(kids[seeds[k] as number]!.n))
  let lo = firstSeed
  let hi = lastSeed
  if (inter.size > 0 && !inter.has(LINK_NAME)) {
    while (lo > 0 && kids[lo - 1]!.n.isText) {
      const ni = intersect(inter, names(kids[lo - 1]!.n))
      if (ni.size === 0 || ni.has(LINK_NAME)) break
      inter = ni
      lo--
    }
    while (hi < kids.length - 1 && kids[hi + 1]!.n.isText) {
      const ni = intersect(inter, names(kids[hi + 1]!.n))
      if (ni.size === 0 || ni.has(LINK_NAME)) break
      inter = ni
      hi++
    }
  }

  const from = parentStart + kids[lo]!.off
  const to = parentStart + kids[hi]!.off + kids[hi]!.n.nodeSize

  // 标记集完全相等 → 经典区域（含 link 支持，同旧模型）
  const seedKey = names(kids[lo]!.n).sort().join(',')
  const allEqual = kids.slice(lo, hi + 1).every(({ n }) => names(n).sort().join(',') === seedKey)
  if (allEqual) {
    const u = uniformMarks(state.doc, from, to)
    if (!u) return null
    // 链接区域取第一个 link mark 的 href（展开为字面时地址要可见可编辑）
    let href = ''
    if (u.includes(LINK_NAME)) {
      state.doc.nodesBetween(from, to, (n) => {
        if (href) return
        const lm = n.marks.find((m) => m.type.name === LINK_NAME)
        if (lm) href = String(lm.attrs?.['href'] ?? '')
      })
    }
    return { from, to, markNames: u, href }
  }

  // 混合 → 整跨区：交集全为符号 mark 且 serializer 可用
  const ordered = MARK_ORDER.filter((m) => m !== LINK_NAME && inter.has(m))
  if (ordered.length === 0 || !getPMSerializer()) return null
  return { from, to, markNames: ordered, href: '', span: true }
}

/** 调试钩子：浏览器控制台读当前展开态（window.__mfPMView 由 pm-view 写入，
 *  生产无碍，只是引用）——复现"展开后不合拢"类问题时区分破形/边界/mapping */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).mfRevealedDebug = () => {
    const v = (window as unknown as Record<string, unknown>).__mfPMView as { state: unknown } | undefined
    return v ? markSourceRevealKey.getState(v.state as never) : null
  }
}

export const markSourceRevealPlugin = new Plugin({
  key: markSourceRevealKey,
  state: {
    init: (): { revealed: Revealed | null } => ({ revealed: null }),
    apply(tr, prev): { revealed: Revealed | null } {
      const metaSelf = tr.getMeta(markSourceRevealKey) as { revealed?: Revealed | null } | undefined
      if (metaSelf && 'revealed' in metaSelf) return { revealed: metaSelf.revealed ?? null }
      if (!tr.docChanged && !tr.selectionSet) return prev
      if (!prev.revealed) return prev
      const { from, to } = prev.revealed
      // 偏置方向：from 用 +1（起点前插入的文本不属于构造体，from 跟随其后），
      // to 用 -1（末尾后插入的文本不属于构造体）——方向写反会把新输入字符
      // 吸收进展开区，符号校验永远失败，离开后无法恢复（用户实测场景）
      const mapped = { ...prev.revealed, from: tr.mapping.map(from, 1), to: tr.mapping.map(to, -1) }
      if (mapped.to <= mapped.from) return { revealed: null }
      return { revealed: mapped }
    },
  },
  appendTransaction(trs, _oldState, newState): Transaction | null {
    const self = markSourceRevealKey.getState(newState) as { revealed: Revealed | null }
    const anyOwn = trs.some((t) => t.getMeta(markSourceRevealKey))
    if (anyOwn) return null

    // ① 已展开：光标离开 → 尝试合拢
    if (self.revealed) {
      if (selectionNear(newState, self.revealed.from, self.revealed.to)) return null
      const text = newState.doc.textBetween(self.revealed.from, self.revealed.to, '\n', ' ')
      // 整跨区：内层是混合标记的 markdown 源码，必须重解析还原
      // （按名单平铺会抹掉内层标记）；破形仍保持字面
      if (self.revealed.span) {
        const frag = reparseAsMarkdown(text)
        const tr = newState.tr
        tr.setMeta('addToHistory', false)
        if (frag) tr.replaceWith(self.revealed.from, self.revealed.to, frag)
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      const parsed = parseRevealed(text, self.revealed.syntax, self.revealed.markNames.includes(LINK_NAME))
      if (parsed === null) {
        // 宽限重解析：定界符之间被插入文本（非删除定界符）时按 markdown
        // 重建（Typora 语义）；真破形（无标记残留）才保持字面
        const frag = reparseAsMarkdown(text)
        const tr = newState.tr
        tr.setMeta('addToHistory', false)
        if (frag) {
          tr.replaceWith(self.revealed.from, self.revealed.to, frag)
          tr.setMeta(markSourceRevealKey, { revealed: null })
          return tr
        }
        // 符号被改动（删除/编辑）→ 保持字面（Typora：格式已破，剩余符号即文本）
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      const tr = newState.tr
      // 展开/合拢是视图态变换：不进 y-undo 栈（yjs captureTransaction 与
      // PM history 都认 addToHistory meta），否则白占一步 Cmd+Z
      tr.setMeta('addToHistory', false)
      if (parsed.content === '') {
        // 空内容（如 **** / [](u)）：不造空文本节点，整段消解
        tr.delete(self.revealed.from, self.revealed.to)
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      collapseRevealed(tr, newState.schema, self.revealed, parsed)
      return tr
    }

    // ② 未展开：光标紧邻/位于标记区域 → 展开
    const region = regionAt(newState)
    if (!region) return null
    const tr = newState.tr
    // 同上：视图态变换不占 undo 步
    tr.setMeta('addToHistory', false)
    // 整跨区：字面内层由 serializer 现算（公共标记由定界符代表被剥除）
    const literal = region.span
      ? (() => {
          const inner = serializeSpanInner(
            newState.doc.slice(region.from, region.to).content,
            newState.schema,
            region.markNames,
          )
          return inner === null ? null : buildLiteral(region.markNames, inner)
        })()
      : buildLiteral(region.markNames, newState.doc.textBetween(region.from, region.to, '\n', ' '), region.href)
    if (literal === null) return null
    // replaceWith + 无标记文本节点：insertText 会继承被替换范围的标记（字面 ** 会被加粗）
    tr.replaceWith(region.from, region.to, newState.schema.text(literal))
    tr.setMeta(markSourceRevealKey, {
      revealed: {
        from: region.from,
        to: region.from + literal.length,
        syntax: syntaxOf(region.markNames),
        markNames: region.markNames,
        ...(region.span ? { span: true } : {}),
      },
    })
    return tr
  },
})
