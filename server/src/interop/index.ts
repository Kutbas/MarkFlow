import * as Y from 'yjs'
import { prosemirrorToYDoc, yDocToProsemirror } from 'y-prosemirror'
import { getHeadless } from '@markflow/shared/headless'

/** Markdown 文本 → Yjs 增量 update（与前端编辑器同构的 schema） */
export async function mdToUpdate(markdown: string): Promise<Uint8Array> {
  const { parse } = await getHeadless()
  return Y.encodeStateAsUpdate(prosemirrorToYDoc(parse(markdown)))
}

/** Yjs 文档 → Markdown 文本（落盘用） */
export async function yDocToMd(ydoc: Y.Doc): Promise<string> {
  const { schema, serialize } = await getHeadless()
  return serialize(yDocToProsemirror(schema, ydoc))
}
