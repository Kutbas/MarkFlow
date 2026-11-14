/** 被行内代码吞掉的加粗定界修复（Typora 宽松行为对齐） */
import { describe, expect, it } from 'vitest'
import { fixSwallowedEmphasis } from '@markflow/shared/inline-fix'

describe('fixSwallowedEmphasis', () => {
  it('损坏形态：闭 ** 被吸进 code 内容尾部 → 挪回反引号外（用户实测场景）', () => {
    expect(fixSwallowedEmphasis('* **返回值如果是 `false**`：线程认为条件没满足。')).toBe(
      '* **返回值如果是 `false`**：线程认为条件没满足。',
    )
    expect(fixSwallowedEmphasis('* **返回值如果是 `true**`：条件满足。')).toBe(
      '* **返回值如果是 `true`**：条件满足。',
    )
  })

  it('正常配对形态不动（code 开反引号后是闭反引号而非 **）', () => {
    const src = '**文字 `code` 结束** 以及 **加粗**'
    expect(fixSwallowedEmphasis(src)).toBe(src)
  })

  it('无行内代码的不成对 ** 不动', () => {
    const src = '单个 ** 不成对 和 * 星号'
    expect(fixSwallowedEmphasis(src)).toBe(src)
  })

  it('一段多行文本中只修命中行', () => {
    const src = '前文正常 **加粗**。\n\n* **返回值如果是 `false**`：说明。\n* 正常列表项。'
    expect(fixSwallowedEmphasis(src)).toBe('前文正常 **加粗**。\n\n* **返回值如果是 `false`**：说明。\n* 正常列表项。')
  })
})

describe('fixSwallowedEmphasis + headless 管线（渲染为加粗+行内代码）', () => {
  it('损坏文本经 parse 产出 strong 内嵌 inlineCode', async () => {
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    const doc = parse('* **返回值如果是 `false**`：线程认为条件没满足。\n')
    let strongWithCode = false
    let literalLeak = false
    doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strong')) strongWithCode = true
      if (n.isText && n.marks.length === 0 && n.textContent.includes('**')) literalLeak = true
    })
    expect(strongWithCode).toBe(true)
    expect(literalLeak).toBe(false)
  })
})
