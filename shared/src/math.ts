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
    marks: '',
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

/// CJK 宽松强调（全角标点紧贴 ** 时仍识别为加粗——Typora 同款行为）
/// 见 https://github.com/commonmark/commonmark-spec/issues/650
export const remarkCjkFriendlyPlugin = $remark(
  'remarkCjkFriendly',
  // remark-cjk-friendly 的 parseOnly 是 this-less 插件（返回 void），类型与 milkdown 期望不符但运行时兼容
  () => remarkCjkFriendlyParseOnly as never,
)
