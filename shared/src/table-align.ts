import type { Ctx } from '@milkdown/ctx'
import type { NodeSchema } from '@milkdown/transformer'
import {
  tableCellSchema,
  tableHeaderRowSchema,
  tableHeaderSchema,
} from '@milkdown/preset-gfm'

type SchemaFactory = (ctx: Ctx) => NodeSchema

/**
 * 表格对齐修复：preset-gfm 的 cell alignment 默认值是 'left'，
 * 而 y-prosemirror 在 PM→Y 转换时会丢弃值为 null 的属性、重建时回填 schema 默认值。
 * 若默认值为 'left'，`| --- |` 会在协同往返后被改写成 `| :--- |`。
 * 将默认值改为 null 即可保持用户原始的对齐标记。
 */
const withNullAlign = (prev: SchemaFactory): SchemaFactory => {
  return (ctx) => {
    const base = prev(ctx)
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alignment: {
          default: null,
          getFromDOM: (dom: { style?: { textAlign?: string } }) =>
            dom.style?.textAlign || null,
          setDOMAttr: (
            value: string | null,
            out: Record<string, unknown>,
          ) => {
            if (value) out['style'] = `text-align: ${value}`
          },
        },
      },
    }
  }
}

export const tableCellAlignNull = tableCellSchema.extendSchema(withNullAlign)
export const tableHeaderAlignNull = tableHeaderSchema.extendSchema(withNullAlign)

/**
 * 表头行输出 <thead>：preset-gfm 的 table_header_row 未定义 toDOM（回落为 tr），
 * 导致 Typora 主题的 `#write thead` 三线表规则（表头下边线）永远缺失。
 * 显式渲染 thead（带 data-is-header 供 parseDOM 匹配回读）。
 */
export const tableHeaderRowThead = tableHeaderRowSchema.extendSchema(
  (prev: SchemaFactory): SchemaFactory =>
    (ctx) => {
      const base = prev(ctx)
      return {
        ...base,
        // NodeSpec.toDOM 必须是函数（数组仅合法于返回值）——写成数组会让
        // ProseMirror 渲染到该节点时抛 toDOM is not a function，整段更新中断
        toDOM: () => ['thead', { 'data-is-header': 'true' }, 0],
      }
    },
)
