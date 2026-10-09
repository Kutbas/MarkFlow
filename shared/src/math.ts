import { $nodeAttr, $nodeSchema, $remark } from '@milkdown/utils'
import remarkMath from 'remark-math'
import remarkCjkFriendlyParseOnly from 'remark-cjk-friendly/parseOnly'

/// 数学公式的额外 HTML 属性（与 Typora 主题 CSS 的 .md-math-block/.md-math-inline 类名对齐）
export const mathBlockAttr = $nodeAttr('mathBlock', () => ({
  'data-math-block': '',
}))
export const mathInlineAttr = $nodeAttr('mathInline', () => ({
  'data-math-inline': '',
}))

/// 块级公式 $$...$$（remark-math 的 mdast 节点类型为 math）
export const mathBlockSchema = $nodeSchema('math_block', (ctx) => {
  return {
    content: 'text*',
    group: 'block',
    marks: '',
    defining: true,
    code: true,
    attrs: {
      language: { default: '' },
    },
    parseDOM: [
      {
        tag: 'div[data-math-block]',
        preserveWhitespace: 'full',
      },
    ],
    toDOM: (node) => {
      const attr = ctx.get(mathBlockAttr.key)(node)
      return ['div', { ...attr, class: 'md-math-block' }, 0]
    },
    parseMarkdown: {
      match: ({ type }) => type === 'math',
      runner: (state, node, type) => {
        state.openNode(type)
        state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'math_block',
      runner: (state, node) => {
        state.addNode('math', undefined, node.textContent)
      },
    },
  }
})

/// 行内公式 $...$（remark-math 的 mdast 节点类型为 inlineMath）
export const mathInlineSchema = $nodeSchema('math_inline', () => {
  return {
    content: 'text*',
    group: 'inline',
    inline: true,
    // 允许格式标记（strong/em）：`**$J_{train}$ 高？**` 中的公式需保留 strong；
    // marks:'' 会导致公式被解析成普通文本（后续协同同步时内容丢失）
    marks: 'strong emphasis',
    defining: true,
    code: true,
    attrs: {
      language: { default: '' },
    },
    parseDOM: [
      {
        tag: 'span[data-math-inline]',
        preserveWhitespace: 'full',
      },
    ],
    toDOM: (_node) => ['span', { class: 'md-math-inline' }, 0],
    parseMarkdown: {
      match: ({ type }) => type === 'inlineMath',
      runner: (state, node, type) => {
        state.openNode(type)
        state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === 'math_inline',
      runner: (state, node) => {
        state.addNode('inlineMath', undefined, node.textContent)
      },
    },
  }
})

/// remark-math 解析插件（$ 与 $$ 语法）
export const remarkMathPlugin = $remark('remarkMath', () => remarkMath)

/**
 * 引用块内的 $$ 公式提升为独立块：remark-math 的 math flow 不支持在容器内
 * 闭合（`> $$` 开块后，后续 `> 内容` 行的引用前缀被原样吞进公式 value 且引用
 * 块被切断——Typora 写法在此引擎下会损坏）。提升后内容剥离 `> ` 前缀。
 * 同时修复已被污染的历史数据：裸 math 块内全部行以 `> ` 开头时剥除前缀。
 */
export function liftQuotedMath(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  const unquote = (l: string) => l.replace(/^(\s*>\s?)/, '')
  const isQuoteLine = (l: string) => /^\s*>/.test(l)
  while (i < lines.length) {
    const line = lines[i]!
    if (isQuoteLine(line) && unquote(line).trim() === '$$') {
      // 收集引用形式的内容行直到引用形式的 $$ 闭合
      let j = i + 1
      const content: string[] = []
      let closed = false
      while (j < lines.length) {
        const l = lines[j]!
        if (isQuoteLine(l) && unquote(l).trim() === '$$') {
          closed = true
          break
        }
        content.push(unquote(l))
        j++
      }
      if (closed && content.length > 0) {
        out.push('', '$$')
        for (const c of content) out.push(c.trim())
        out.push('$$', '')
        i = j + 1
        continue
      }
    }
    out.push(line)
    i++
  }
  // 历史污染修复：裸 math 块内所有行以 > 开头 → 剥前缀
  return out
    .join('\n')
    .replace(/\$\$\n((?:>[^\n]*\n)+)\$\$/g, (m, body: string) => {
      const inner = String(body).split('\n').filter(Boolean).filter((l) => l.trim() !== '>')
      if (inner.length > 0 && inner.every((l) => /^>/.test(l))) {
        return '$$\n' + inner.map((l) => l.replace(/^>\s?/, '').trimEnd()).join('\n') + '\n$$'
      }
      return m
    })
}

/**
 * 块公式定界符规范化：remark-math（micromark-extension-math）的块级规则
 * 要求 $$ 独占一行（fenced 形式），Typora 宽松支持的三种写法都会出问题：
 * 1. 单行 `$$公式$$` → 降级为行内公式（双美元丢失，全文 $$ 奇偶错位）
 * 2. `$$\begin{cases}` 开定界后跟内容 → 内容被当 info string 丢弃，块吞到下一个独立 $$ 或 EOF
 * 3. `\end{cases}$$` 闭合定界贴内容 → 不被识别为闭合，块继续吞正文
 * 导入/粘贴/播种前统一改写为三行 fenced 形式。fenced 代码块内的 $$ 不动。
 */
export function normalizeBlockMath(md: string): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$))/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      let s = part
      // 1) 单行 $$..$$ 对 → 三行 fenced
      s = s.replace(
        /(^|\n)[ \t]*\$\$[ \t]*([^\n]+?)[ \t]*\$\$[ \t]*(?=\n|$)/g,
        (m, pre: string, inner: string) => (inner.trim() ? `${pre}$$\n${inner.trim()}\n$$` : m),
      )
      // 2) 行首 $$ 后跟内容（开定界带内容）→ 内容保留并拆到下一行
      s = s.replace(
        /(^|\n)[ \t]*\$\$[ \t]*([^\n$]+?)[ \t]*(?=\n|$)/g,
        (_m, pre: string, rest: string) => `${pre}$$\n${rest.trim()}`,
      )
      // 3) 内容后行尾 $$（闭合定界贴内容）→ 拆成独立闭合行
      s = s.replace(
        /(^|\n)([^\n$]*?)[ \t]*\$\$[ \t]*(?=\n|$)/g,
        (m, pre: string, rest: string) => (rest.trim() ? `${pre}${rest.trim()}\n$$` : m),
      )
      return s
    })
    .join('')
}

/// CJK 宽松强调（全角标点紧贴 ** 时仍识别为加粗——Typora 同款行为）
/// 见 https://github.com/commonmark/commonmark-spec/issues/650
export const remarkCjkFriendlyPlugin = $remark(
  'remarkCjkFriendly',
  // remark-cjk-friendly 的 parseOnly 是 this-less 插件（返回 void），类型与 milkdown 期望不符但运行时兼容
  () => remarkCjkFriendlyParseOnly as never,
)
