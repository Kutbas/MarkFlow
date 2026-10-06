import type { Ctx } from '@milkdown/ctx'
import type { NodeSchema } from '@milkdown/transformer'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/preset-gfm'

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
