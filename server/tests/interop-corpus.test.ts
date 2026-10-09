/**
 * md ⇄ Yjs 转换语料库（含 shared 的 math/table-align schema DOM 回调分支）。
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorToYDoc, yDocToProsemirror } from 'y-prosemirror'
import { getHeadless } from '@markflow/shared/headless'
import { mathBlockSchema, mathInlineSchema } from '@markflow/shared'

const { schema, parse, serialize, ctx } = await getHeadless()

function roundtrip(md: string): { back: string; stable: boolean } {
  const back = serialize(parse(md))
  return { back, stable: serialize(parse(back)) === back }
}

describe('interop 语料库 roundtrip', () => {
  it('标题层级', () => {
    const md = '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n'
    const { back, stable } = roundtrip(md)
    expect(stable).toBe(true)
    for (const h of ['# 一', '## 二', '### 三', '#### 四', '##### 五', '###### 六']) {
      expect(back).toContain(h)
    }
  })

  it('GFM 表格（无对齐/左/中/右对齐保持）', () => {
    const md = '| a | b | c |\n| --- | :--- | ---: |\n| 1 | 2 | 3 |\n'
    const { back, stable } = roundtrip(md)
    expect(stable).toBe(true)
    // remark-stringify 使用紧凑形态 :- 与 -:
    expect(back).toMatch(/:-/)
    expect(back).toMatch(/-:/)
    // 无对齐列保持无冒号
    const plain = roundtrip('| x | y |\n| --- | --- |\n| 1 | 2 |\n')
    expect(plain.back).toMatch(/\| -+ \| -+ \|/)
  })

  it('任务列表勾选状态', () => {
    const { back, stable } = roundtrip('- [x] 完成\n- [ ] 待办\n')
    expect(stable).toBe(true)
    expect(back).toContain('[x] 完成')
    expect(back).toContain('[ ] 待办')
  })

  it('删除线 / 行内代码 / 加粗斜体嵌套', () => {
    const { back, stable } = roundtrip('~~删除~~ 与 **粗体** 与 *斜体* 与 `code`\n')
    expect(stable).toBe(true)
    expect(back).toContain('~~删除~~')
    expect(back).toContain('**粗体**')
    expect(back).toContain('*斜体*')
    expect(back).toContain('`code`')
  })

  it('脚注', () => {
    const { back, stable } = roundtrip('正文[^1]。\n\n[^1]: 脚注内容。\n')
    expect(stable).toBe(true)
    expect(back).toContain('[^1]')
    expect(back).toContain('脚注内容')
  })

  it('数学：行内与块级', () => {
    const { back, stable } = roundtrip('行内 $a+b$ 与块级：\n\n$$\nE=mc^2\n$$\n')
    expect(stable).toBe(true)
    expect(back).toContain('$a+b$')
    expect(back).toContain('$$')
    expect(back).toContain('E=mc^2')
  })

  it('Mermaid 源码块与普通代码块', () => {
    const { back, stable } = roundtrip('```mermaid\ngraph LR\nA-->B\n```\n\n```python\nprint(1)\n```\n')
    expect(stable).toBe(true)
    expect(back).toContain('```mermaid')
    expect(back).toContain('graph LR')
    expect(back).toContain('```python')
  })

  it('引用嵌套与分隔线与链接图片', () => {
    const { back, stable } = roundtrip('> 外层\n> > 内层\n\n---\n\n[链接](https://a.b) ![图](x.png)\n')
    expect(stable).toBe(true)
    expect(back).toContain('> 外层')
    expect(back).toContain('内层')
    expect(back).toContain('[链接](https://a.b)')
    expect(back).toContain('![图](x.png)')
  })

  it('空文档与纯空白', () => {
    expect(roundtrip('').back).toBe('')
    expect(roundtrip('\n\n\n').stable).toBe(true)
  })

  it('有序列表嵌套无序列表', () => {
    const { back, stable } = roundtrip('1. 一级\n   - 二级甲\n   - 二级乙\n2. 又一级\n')
    expect(stable).toBe(true)
    expect(back).toContain('一级')
    expect(back).toContain('二级甲')
  })

  it('全链路：md → PM → Y → PM → md 完全一致', () => {
    const md = '# 标\n\n| k | v |\n| --- | --- |\n| 1 | 2 |\n\n$公式$\n\n- [x] t\n'
    const doc = parse(md)
    const ydoc = prosemirrorToYDoc(doc)
    const doc2 = yDocToProsemirror(schema, ydoc)
    expect(serialize(doc2)).toBe(serialize(doc))
    // 增量 update 在另一个空文档上还原一致
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc))
    expect(serialize(yDocToProsemirror(schema, other))).toBe(serialize(doc))
  })
})

describe('shared schema 的 DOM 回调（toDOM / parseDOM / 对齐属性）', () => {
  it('math 节点 toDOM 可脱离浏览器调用', () => {
    const blockSpec = mathBlockSchema.node.schema as unknown as {
      toDOM?: (node: unknown) => unknown[]
    }
    const inlineSpec = mathInlineSchema.node.schema as unknown as {
      toDOM?: (node: unknown) => unknown[]
    }
    const blockNode = schema.nodes['math_block']!.createAndFill()
    const inlineNode = schema.nodes['math_inline']!.createAndFill()
    expect(blockNode).toBeTruthy()
    expect(inlineNode).toBeTruthy()
    expect(JSON.stringify(blockSpec.toDOM?.(blockNode))).toContain('md-math-block')
    expect(JSON.stringify(inlineSpec.toDOM?.(inlineNode))).toContain('md-math-inline')
  })

  it('math parseDOM 规则存在且标签匹配', () => {
    const blockSpec = mathBlockSchema.node.schema as unknown as {
      parseDOM?: { tag: string }[]
    }
    expect(blockSpec.parseDOM?.[0]?.tag).toBe('div[data-math-block]')
  })

  it('表格 cell 的 alignment 默认值为 null（协同往返保持）', () => {
    const cell = schema.nodes['table_cell']!
    expect(cell.createAndFill()?.attrs['alignment']).toBeNull()
    const header = schema.nodes['table_header']!
    expect(header.createAndFill()?.attrs['alignment']).toBeNull()
    // 显式 center 对齐可正常设置
    const c = cell.create({ alignment: 'center' } as never)
    expect(c.attrs['alignment']).toBe('center')
  })
})

describe('行内公式不断段（inline 语义）', () => {
  it('段落中的多个 $x$ 保持在同一段内', () => {
    const md = '质能方程 $E = mc^2$ 是行内，$a+b=c$ 也在同一行。\n'
    const doc = parse(md)
    // 顶层应只有 1 个段落块（内联公式不拆行）
    expect(doc.childCount).toBe(1)
    const para = doc.child(0)
    expect(para.type.name).toBe('paragraph')
    // 段内含 math_inline 节点且为 inline
    const kinds: string[] = []
    para.forEach((c: { type: { name: string; spec: { inline?: boolean } } }) => {
      kinds.push(c.type.name)
    })
    expect(kinds).toContain('math_inline')
    expect(schema.nodes['math_inline']!.spec.inline).toBe(true)
    expect(schema.nodes['math_block']!.spec.inline).toBeUndefined()
    // 序列化还原为同一行
    const back = serialize(doc)
    expect(back).toContain('是行内')
    expect(back).toContain('也在同一行')
  })

  it('AI.md 式语料：整段含公式不碎块', () => {
    const md = '能量 $E$ 与质量 $m$ 满足 $E=mc^2$ 的关系，详见下文。\n'
    const doc = parse(md)
    expect(doc.childCount).toBe(1)
  })
})

describe('CJK 宽松强调（remark-cjk-friendly）', () => {
  it('全角标点紧贴闭合 ** 仍识别为加粗', () => {
    const cases = [
      '我们使用**均方误差（MSE）**作为代价函数\n',
      '**宏观认知本质上是构建对行业的世界观**。当世界观\n',
      '**该星号不会被识别，而是直接显示。**这是因为\n',
      '**重要提示**：请注意\n',
    ]
    for (const md of cases) {
      const doc = parse(md)
      let hasStrong = false
      doc.descendants((n) => {
        if ((n.marks as unknown as { type: { name: string } }[]).some((m) => m.type.name === 'strong')) {
          hasStrong = true
        }
      })
      expect(hasStrong, md.slice(0, 20)).toBe(true)
    }
  })

  it('roundtrip 稳定（序列化后仍为合法 strong）', () => {
    const md = '我们使用**均方误差（MSE）**作为代价函数\n'
    const back = serialize(parse(md))
    expect(serialize(parse(back))).toBe(back)
    expect(back).toContain('**')
  })
})
