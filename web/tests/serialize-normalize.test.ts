/** 序列化侧 emphasis marker 归一化：防 Mark.eq 失败拆段接合 `****` */
import { expect, it } from 'vitest'
import { Transform } from '@milkdown/kit/prose/transform'
import { getHeadless } from '@markflow/shared/headless'

it("非默认 marker（input rule 产物 '_'）：序列化归一后仍单一包裹", async () => {
  const h = await getHeadless()
  const doc = h.parse('aa MicroLIB bb\n')
  const strong = h.schema.marks['strong']!
  const code = h.schema.marks['inlineCode']!
  // 三段同属一个逻辑加粗段，但 marker 都是 '_'（input rule __x__ 的产物形态）
  const tr = new Transform(doc)
  tr.addMark(1, 4, strong.create({ marker: '_' }))
  tr.addMark(4, 12, strong.create({ marker: '_' }))
  tr.addMark(4, 12, code.create())
  tr.addMark(12, 15, strong.create({ marker: '_' }))
  // 无归一化时 Mark.eq 失败 → 拆段 → `**aa ****`MicroLIB`**** bb**` 不可解析
  const out = h.serialize(tr.doc as never)
  expect(out).toBe('**aa `MicroLIB` bb**\n')
})

it('默认 marker 文档序列化零改动直通', async () => {
  const h = await getHeadless()
  expect(h.serialize(h.parse('**加粗** 与 `code`\n'))).toBe('**加粗** 与 `code`\n')
})
