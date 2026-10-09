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
import type { Node, Schema } from 'prosemirror-model'
import { markflowPreset } from './index.js'
import { liftQuotedMath, normalizeBlockMath } from './math.js'
export interface HeadlessInterop {
  schema: Schema
  parse: (markdown: string) => Node
  serialize: (doc: Node) => string
  /** 装配完成的 milkdown Ctx（供测试调用 schema 的 DOM 相关回调） */
  ctx: Ctx
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
    // 解析前规范化：引用块内公式提升（math flow 不支持容器内闭合）+ 定界符规范化
    parse: (md: string) => rawParse(normalizeBlockMath(liftQuotedMath(md))),
    serialize: ctx.get(serializerCtx),
    ctx,
  }
  return cached
}
