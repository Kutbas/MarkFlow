import type { MilkdownPlugin } from '@milkdown/ctx'

import {
  mathBlockAttr,
  mathBlockSchema,
  mathInlineAttr,
  mathInlineSchema,
  remarkMathPlugin,
} from './math.js'
import { tableCellAlignNull, tableHeaderAlignNull, tableHeaderRowThead } from './table-align.js'
import { imageTitleFix } from './image-fix.js'

export * from './math'
export * from './table-align'

/**
 * MarkFlow 专属 preset：在 commonmark + gfm 之上追加
 * - 数学公式（$ 行内 / $$ 块级，MathJax 前端渲染）
 * - 表格对齐修复（alignment 默认 null，保持 | --- | 原样）
 * 服务端无头转换与前端编辑器必须使用同一组 schema，否则 CRDT 节点无法互认。
 */
export const markflowPreset: MilkdownPlugin[] = [
  remarkMathPlugin,
  mathBlockAttr,
  mathInlineAttr,
  mathBlockSchema,
  mathInlineSchema,
  tableCellAlignNull,
  tableHeaderAlignNull,
  tableHeaderRowThead,
  imageTitleFix,
].flat()
