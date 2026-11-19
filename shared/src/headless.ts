import './dom-shim.js'
import { Clock, Container, Ctx } from '@milkdown/ctx'
import {
  commands,
  config,
  init,
  keymap,
  parser,
  parserCtx,
  pasteRule,
  schema,
  schemaCtx,
  serializer,
  serializerCtx,
} from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { Transform } from '@milkdown/prose/transform'
import type { Mark, MarkType, Node, Schema } from 'prosemirror-model'
import { markflowPreset } from './index.js'
import { liftQuotedMath, normalizeBlockMath } from './math.js'
import { fixSwallowedEmphasis } from './inline-fix.js'
import { nestBulletsUnderOrdered } from './list-fix.js'
export interface HeadlessInterop {
  schema: Schema
  parse: (markdown: string) => Node
  serialize: (doc: Node) => string
  /** 装配完成的 milkdown Ctx（供测试调用 schema 的 DOM 相关回调） */
  ctx: Ctx
}

/**
 * 序列化前归一 emphasis 系 mark（strong/emphasis）的 marker attr 到类型
 * 默认（'*'）：input rule 可产出 '_' 等非默认 marker，序列器的"继续标记"
 * 判定用 Mark.eq——attr 不一致即拆段，同一段格式被闭开成相邻节点，接合
 * 出不可解析的 `****` 形态（重解析加粗丢失）。只影响序列化视图，不改
 * 文档本体；无偏差时原样返回（零开销）。
 */
function normalizeEmphasisMarkers(doc: Node): Node {
  const defaults = new Map<string, Mark>()
  const targets: Array<[from: number, to: number, type: MarkType]> = []
  doc.descendants((n, p) => {
    if (!n.isText) return
    for (const m of n.marks) {
      if (m.type.name !== 'strong' && m.type.name !== 'emphasis') continue
      let def = defaults.get(m.type.name)
      if (!def) {
        def = m.type.create()
        defaults.set(m.type.name, def)
      }
      if (!def.eq(m)) targets.push([p, p + n.nodeSize, m.type])
    }
  })
  if (targets.length === 0) return doc
  const tr = new Transform(doc)
  for (const [from, to, type] of targets) tr.addMark(from, to, defaults.get(type.name)!)
  return tr.doc
}

let cached: HeadlessInterop | null = null

/**
 * 装配无头 milkdown 管线（schema + parser + serializer，无 DOM 依赖）。
 * 跳过 editorState/editorView（浏览器专用），结果进程内缓存一次。
 */
export async function getHeadless(): Promise<HeadlessInterop> {
  if (cached) return cached

  const ctx = new Ctx(new Container(), new Clock())
  const plugins = [
    config(() => {}),
    init({} as never),
    commands,
    schema,
    parser,
    serializer,
    keymap,
    pasteRule,
    ...commonmark,
    ...gfm,
    ...markflowPreset,
  ]

  // stage1：注入 slices；stage2：并行执行，计时器保证依赖顺序
  const handlers = plugins.map((p) => (p as (c: Ctx) => () => unknown)(ctx))
  await Promise.all(handlers.map((h) => h()))

  const rawParse = ctx.get(parserCtx)
  cached = {
    schema: ctx.get(schemaCtx),
    // 解析前规范化：引用块内公式提升（math flow 不支持容器内闭合）+ 定界符
    // 规范化 + 被行内代码吞掉的加粗定界修复 + 有序项下压平无序项恢复嵌套
    // （Typora 宽松行为对齐）
    parse: (md: string) =>
      rawParse(nestBulletsUnderOrdered(fixSwallowedEmphasis(normalizeBlockMath(liftQuotedMath(md))))),
    // 序列化前归一 emphasis marker（防 **** 拆段接合）
    serialize: (doc: Node) => (ctx.get(serializerCtx) as (d: Node) => string)(normalizeEmphasisMarkers(doc)),
    ctx,
  }
  return cached
}
