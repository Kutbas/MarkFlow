/**
 * M2 spike：通过 @markflow/shared 验证 md ⇄ Yjs 无头转换全链路。
 */
import fs from 'node:fs'
import * as Y from 'yjs'
import { prosemirrorToYDoc, yDocToProsemirror } from 'y-prosemirror'
import { getHeadless } from '@markflow/shared/headless'

const { schema, parse, serialize } = await getHeadless()
console.log('[spike] nodes:', Object.keys(schema.nodes).join(', '))
console.log('[spike] marks:', Object.keys(schema.marks).join(', '))

const md = fs.readFileSync(
  new URL('../../seeds/notes/欢迎使用 MarkFlow.md', import.meta.url),
  'utf8',
)
const doc = parse(md)

const back = serialize(doc)
const roundtrip = serialize(parse(back))
console.log('[spike] 二次序列化稳定:', roundtrip === back ? '✅' : '❌')
if (roundtrip !== back) {
  console.log('第一次:', JSON.stringify(back.slice(0, 200)))
  console.log('第二次:', JSON.stringify(roundtrip.slice(0, 200)))
}

// 表格对齐保持检查：原始 | ---- | 不应变成 | :--- |
const tableLine = back.split('\n').find((l) => /^\| -/.test(l))
console.log('[spike] 表格分隔行:', JSON.stringify(tableLine))
console.log(
  '[spike] 对齐未被改写:',
  tableLine && !tableLine.includes(':') ? '✅' : '❌(被改写为 :---)',
)

// PM ⇄ Y 全链路
const ydoc = prosemirrorToYDoc(doc)
const update1 = Y.encodeStateAsUpdate(ydoc)
const doc2 = yDocToProsemirror(schema, ydoc)
console.log('[spike] PM→Y→PM 一致:', serialize(doc2) === back ? '✅' : '❌')

const ydocB = new Y.Doc()
Y.applyUpdate(ydocB, update1)
const docB = yDocToProsemirror(schema, ydocB)
console.log('[spike] 增量 update 还原:', serialize(docB) === back ? '✅' : '❌')

// 模拟协同：A 修改标题，B 应用 update 后各自序列化应一致
const ydocA = new Y.Doc()
Y.applyUpdate(ydocA, update1)
ydocA.getXmlFragment('prosemirror') // 确认 fragment 名
const frag = ydocA.getXmlFragment('prosemirror')
const headingEl = frag.firstChild
if (headingEl && headingEl.constructor.name === 'XmlElement') {
  // 改标题第一个文本子节点
  const textChild = headingEl.toArray().find((c) => typeof c === 'object' && 'delta' in c)
  if (textChild && 'delete' in (textChild as object)) {
    const t = textChild as { length: number; delete: (n: number) => void; insert: (i: number, s: string) => void }
    t.delete(t.length)
    t.insert(0, '# 标题被 A 改掉了\n')
  }
}
Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA))
const mdA = serialize(yDocToProsemirror(schema, ydocA))
const mdB = serialize(yDocToProsemirror(schema, ydocB))
console.log('[spike] A/B 协同收敛:', mdA === mdB ? '✅' : '❌')
console.log('[spike] A 修改后首行:', JSON.stringify(mdA.split('\n')[0]))

// math 节点验证
const mathMd = '行内 $E=mc^2$ 与块级：\n\n$$\n\\frac{1}{2}\n$$\n'
const mathDoc = parse(mathMd)
const mathBack = serialize(mathDoc)
console.log('[spike] math 解析节点:', (() => {
  const names: string[] = []
  mathDoc.forEach((n) => names.push(n.type.name))
  return names.join(',')
})())
console.log('[spike] math 往返:', mathBack === mathMd ? '✅' : `❌ → ${JSON.stringify(mathBack)}`)
const mathRound = serialize(parse(mathBack))
console.log('[spike] math 二次稳定:', mathRound === mathBack ? '✅' : `❌ → ${JSON.stringify(mathRound)}`)

console.log('[spike] 全部完成')
process.exit(0)
