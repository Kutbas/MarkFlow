import { describe, expect, it } from 'vitest'
import { normalizeBlockMath } from '@markflow/shared/math'

describe('normalizeBlockMath 块公式定界符规范化', () => {
  it('单行 $$..$$ 拆为三行 fenced', () => {
    expect(normalizeBlockMath('前文\n\n$$E=mc^2$$\n\n后文\n')).toBe('前文\n\n$$\nE=mc^2\n$$\n\n后文\n')
  })

  it('开定界后跟内容（cases 形态）：内容保留并拆行', () => {
    expect(normalizeBlockMath('$$\\begin{cases} \nx = 1\n')).toBe('$$\n\\begin{cases}\nx = 1\n')
  })

  it('闭合定界贴内容：拆成独立闭合行', () => {
    expect(normalizeBlockMath('x = 1\n\\end{cases}$$\n')).toBe('x = 1\n\\end{cases}\n$$\n')
  })

  it('完整的松散 cases 块往返为标准形式', () => {
    const src = '$$\\begin{cases} \nx = 1 \\\\\ny = 2\n\\end{cases}$$\n'
    expect(normalizeBlockMath(src)).toBe('$$\n\\begin{cases}\nx = 1 \\\\\ny = 2\n\\end{cases}\n$$\n')
  })

  it('独立行的 $$ 不动；行内单美元 $x$ 不动', () => {
    const src = '$$\nE=mc\n$$\n以及 $x$ 行内\n'
    expect(normalizeBlockMath(src)).toBe(src)
  })

  it('fenced 代码块内的 $$ 原样保留', () => {
    const src = '```\n$$raw$$\n$$\ncode\n$$\n```\n'
    expect(normalizeBlockMath(src)).toBe(src)
  })

  it('空内容不误拆（$$$$ 与只有空白）', () => {
    expect(normalizeBlockMath('$$$$\n')).toBe('$$$$\n')
  })
})

describe('normalizeBlockMath + headless 管线（吞正文回归）', () => {
  it('松散 cases 公式后跟正文段落：正文不被吞进公式块', async () => {
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    const md = '引言文字：\n\n$$\\begin{cases} \nx = 1\n\\end{cases}$$\n\n中文正文段落。\n\n后续段落。\n'
    const doc = parse(md)
    const types: string[] = []
    doc.forEach((n) => types.push(n.type.name))
    // 公式块内容只含 LaTeX，正文作为独立段落存在
    expect(types).toContain('paragraph')
    const math: Array<{ type: { name: string }; textContent: string }> = []
    doc.forEach((n) => math.push(n as never))
    const mathBlocks = math.filter((n) => n.type.name === 'math_block')
    expect(mathBlocks).toHaveLength(1)
    expect(mathBlocks[0]!.textContent).not.toContain('中文正文')
    const paras = math.filter((n) => n.type.name === 'paragraph')
    expect(paras.some((p) => p.textContent.includes('中文正文段落'))).toBe(true)
  })
})
