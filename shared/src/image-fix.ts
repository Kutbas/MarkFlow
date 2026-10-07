import type { Ctx } from '@milkdown/ctx'
import type { NodeSchema } from '@milkdown/transformer'
import { imageSchema } from '@milkdown/preset-commonmark'

type SchemaFactory = (ctx: Ctx) => NodeSchema

/**
 * 图片 title 修复：remark AST 中无 title 的图片 `![a](b)` 的 title 为 null，
 * 而 schema 要求 string——直接解析会在再次序列化时抛 RangeError。
 * 解析侧归一 null → ''，序列化侧空 title 省略（避免输出 `![a](b "")`）。
 */
export const imageTitleFix = imageSchema.extendSchema(
  (prev: SchemaFactory): SchemaFactory =>
    (ctx) => {
      const base = prev(ctx)
      return {
        ...base,
        toDOM: (node: { attrs: { src?: string } }) => {
          const src = String(node.attrs.src ?? '')
          // 外链图床走服务端代理绕过 Referer 防盗链；本地/相对地址原样输出
          const nav = (globalThis as { location?: { origin: string } }).location
          const pageOrigin = nav?.origin ?? ''
          const sameOrigin = pageOrigin !== '' && src.startsWith(pageOrigin)
          const proxied =
            src && /^https?:\/\//.test(src) && !sameOrigin
              ? `/api/img?u=${encodeURIComponent(src)}`
              : src
          return ['img', { src: proxied }]
        },
        parseMarkdown: {
          ...base.parseMarkdown,
          runner: (state, node, type) => {
            const patched = { ...node, title: node.title ?? '' } as typeof node
            return base.parseMarkdown!.runner(state, patched, type)
          },
        },
        toMarkdown: {
          ...base.toMarkdown,
          runner: (state, node) => {
            const patched = node.attrs['title']
              ? node
              : ({ ...node, attrs: { ...node.attrs, title: undefined } } as unknown as typeof node)
            return base.toMarkdown!.runner(state, patched)
          },
        },
      }
    },
)
