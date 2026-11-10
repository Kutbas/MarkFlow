/**
 * 标记源码展开（Typora 本质模型）：光标进入/紧邻标记区域（加粗/斜体/
 * 删除线/行内代码/超链接）时，把区域"展开"为字面源码——`**MM**` 的符号
 * 变成真实文本字符：光标可停靠在任意符号前后（原生字符导航）、删除任意
 * 符号是原生字符删除（Typora"删一个 * 加粗消失、其余保留"）。
 * 超链接同机制：点击进入展开为 `[文本](地址)` 字面，改字面 URL 即改链接。
 * 光标离开展开区时"合拢"：符号序列完好 → 恢复渲染态；被改动过（删了
 * 符号等）→ 保持字面文本不动。
 * 多标记叠加按固定顺序拼接（加粗+斜体 = ***，加粗+链接 = **[x](u)**）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'

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

/** markNames + 内容 → 字面源码（link 在场：符号包着 [内容](href)） */
export function buildLiteral(markNames: string[], content: string, href?: string): string {
  const inner = markNames.includes(LINK_NAME) ? `[${content}](${href ?? ''})` : content
  const s = syntaxOf(markNames)
  return s + inner + s
}

/** 字面源码 → 内容/地址（展开区完好性校验与合拢取参共用）：
 *  先剥外层符号；link 在场再匹配 [内容](href)——贪婪到最后一个 ')'，
 *  href 内含 '(' 的罕见 URL 判破形（与 CommonMark 语法同限） */
export function parseRevealed(text: string, syntax: string, hasLink: boolean): RevealedLiteral | null {
  if (text.length < syntax.length * 2 || !text.startsWith(syntax) || !text.endsWith(syntax)) return null
  const body = text.slice(syntax.length, text.length - syntax.length)
  if (!hasLink) return { content: body }
  const m = /^\[([\s\S]*)\]\(([\s\S]*)\)$/.exec(body)
  if (!m) return null
  return { content: m[1]!, href: m[2]! }
}

/** 光标是否仍在展开构造体内（含两端）——[from, to]：停在符号上/之间/紧贴
 *  符号内侧（a/b/c/d 四位）都算交互中；移出一位即离开（Typora：出符号即合拢）。
 *  此前 [from-1, to+1] 过宽：光标停在符号后一位（用户认知的"已移出"）不合拢 */
function selectionNear(state: EditorState, from: number, to: number): boolean {
  const { from: f, to: t } = state.selection
  return f >= from && f <= to && t >= from && t <= to
}

/** 找光标紧邻/所在的齐整标记区域（a/b/c/d 四位或区内） */
function regionAt(
  state: EditorState,
): { from: number; to: number; markNames: string[]; href: string } | null {
  const { $from, empty } = state.selection
  if (!empty) return null
  const parent = $from.parent
  const parentStart = $from.pos - $from.parentOffset
  const pos = $from.pos

  // 扫描父节点内所有文本子节点，找与光标相邻（或包含）的连续同标记段
  const spans: Array<{ from: number; to: number; names: string[] }> = []
  parent.forEach((child, offset) => {
    if (!child.isText || child.marks.length === 0) return
    const absFrom = parentStart + offset
    const absTo = absFrom + child.nodeSize
    // 光标在段内或段的左/右边界
    const adjacent = pos === absFrom || pos === absTo || (pos > absFrom && pos < absTo)
    if (!adjacent) return
    spans.push({ from: absFrom, to: absTo, names: child.marks.map((m) => m.type.name).sort() })
  })
  if (spans.length === 0) return null
  const from = Math.min(...spans.map((s) => s.from))
  const to = Math.max(...spans.map((s) => s.to))
  const names = uniformMarks(state.doc, from, to)
  if (!names) return null
  // 链接区域取第一个 link mark 的 href（展开为字面时地址要可见可编辑）
  let href = ''
  if (names.includes(LINK_NAME)) {
    state.doc.nodesBetween(from, to, (n) => {
      if (href) return
      const lm = n.marks.find((m) => m.type.name === LINK_NAME)
      if (lm) href = String(lm.attrs?.['href'] ?? '')
    })
  }
  return { from, to, markNames: names, href }
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
      const parsed = parseRevealed(text, self.revealed.syntax, self.revealed.markNames.includes(LINK_NAME))
      if (parsed === null) {
        // 符号被改动（删除/编辑）→ 保持字面（Typora：格式已破，剩余符号即文本）
        const tr = newState.tr
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      const tr = newState.tr
      // 展开/合拢是视图态变换：不进 y-undo 栈（yjs captureTransaction 与
      // PM history 都认 addToHistory meta），否则白占一步 Cmd+Z
      tr.setMeta('addToHistory', false)
      const { from, to, markNames } = self.revealed
      if (parsed.content === '') {
        // 空内容（如 **** / [](u)）：不造空文本节点，整段消解
        tr.delete(from, to)
        tr.setMeta(markSourceRevealKey, { revealed: null })
        return tr
      }
      // 按展开时记录的名单还原标记（syntax 反推会误命中：'**'.includes('*')）；
      // link 按字面解析出的 href 重建（改字面 URL = 改链接地址）
      const marks = markNames
        .map((n) =>
          n === LINK_NAME
            ? newState.schema.marks[n]?.create({ href: parsed.href ?? '' })
            : newState.schema.marks[n]?.create(),
        )
        .filter(Boolean)
      tr.replaceWith(from, to, newState.schema.text(parsed.content, marks as never))
      tr.setMeta(markSourceRevealKey, { revealed: null })
      return tr
    }

    // ② 未展开：光标紧邻/位于标记区域 → 展开
    const region = regionAt(newState)
    if (!region) return null
    const content = newState.doc.textBetween(region.from, region.to, '\n', ' ')
    const tr = newState.tr
    // 同上：视图态变换不占 undo 步
    tr.setMeta('addToHistory', false)
    const literal = buildLiteral(region.markNames, content, region.href)
    // replaceWith + 无标记文本节点：insertText 会继承被替换范围的标记（字面 ** 会被加粗）
    tr.replaceWith(region.from, region.to, newState.schema.text(literal))
    tr.setMeta(markSourceRevealKey, {
      revealed: {
        from: region.from,
        to: region.from + literal.length,
        syntax: syntaxOf(region.markNames),
        markNames: region.markNames,
      },
    })
    return tr
  },
})
