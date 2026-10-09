import { describe, expect, it } from 'vitest'
import { liftQuotedMath } from '@markflow/shared/math'
import { getHeadless } from '@markflow/shared/headless'

describe('liftQuotedMath（引用块内公式提升）', () => {
  it('引用块内的 $$ 公式提升为独立块，内容剥 > 前缀', () => {
    const src = '> 提示：\n> $$\n> f(x) = x\n> $$\n> 结论。\n'
    expect(liftQuotedMath(src)).toBe('> 提示：\n\n$$\nf(x) = x\n$$\n\n> 结论。\n')
  })

  it('连续两个引用内公式都提升', () => {
    const src = '> $$\n> a = 1\n> $$\n> $$\n> b = 2\n> $$\n'
    const out = liftQuotedMath(src)
    expect(out).toContain('a = 1')
    expect(out).toContain('b = 2')
    expect(out).not.toContain('> a')
    expect(out).not.toContain('> b')
  })

  it('已污染的裸 math 块（全行 > 前缀）剥除前缀与尾空行', () => {
    expect(liftQuotedMath('$$\n> f(x) = x\n>\n$$\n')).toBe('$$\nf(x) = x\n$$\n')
  })

  it('正常 math 块不动；含 > 比较符的行不误剥（非全行前缀）', () => {
    expect(liftQuotedMath('$$\nE = mc^2\n$$\n')).toBe('$$\nE = mc^2\n$$\n')
    expect(liftQuotedMath('$$\na > b\nc = d\n$$\n')).toBe('$$\na > b\nc = d\n$$\n')
  })

  it('管线端到端：quote 公式解析为干净 math_block（value 无 > 前缀）', async () => {
    const { parse, serialize } = await getHeadless()
    const doc = parse('> 提示：\n> $$\n> f(x) = x\n> $$\n')
    let mathValue: string | null = null
    doc.descendants((n) => {
      if (n.type.name === 'math_block' && mathValue === null) mathValue = n.textContent
    })
    expect(mathValue).toBe('f(x) = x')
    // 往返稳定
    const rt = serialize(doc)
    expect(rt).toContain('f(x) = x')
    expect(rt).not.toContain('> f(')
  })
})
