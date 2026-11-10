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

  it('缩进的单行式拆三行时保留缩进（顶格化会打断列表 → 缩进续行误成代码块）', () => {
    expect(normalizeBlockMath('        $$E=mc^2$$\n')).toBe('        $$\n        E=mc^2\n        $$\n')
  })

  it('缩进的开定界带内容 / 闭定界贴内容拆行时保留缩进', () => {
    expect(normalizeBlockMath('    $$\\begin{cases} \n')).toBe('    $$\n    \\begin{cases}\n')
    expect(normalizeBlockMath('    x = 1\n    \\end{cases}$$\n')).toBe('    x = 1\n    \\end{cases}\n    $$\n')
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

  it('嵌套列表内缩进的单行式公式：列表不断裂、缩进续行不误成代码块（用户实测回归）', async () => {
    const { getHeadless } = await import('@markflow/shared/headless')
    const { parse } = await getHeadless()
    const md = [
      '2. **进制分野（十进制** $1000$ vs. 二进制 $1024$）：',
      '    * **通信与硬件制造领域：** 严格遵从国际单位制（SI）的十进制标准。',
      '',
      '        $$1\\text{ k} = 10^3 = 1000, \\quad 1\\text{ M} = 10^6 = 1,000,000$$',
      '',
      '        （就如 HR 谈薪资“20k”指的是 $20 \\times 1000 = 2\\text{万}$，而非 $20 \\times 1024$）；',
      '    *   **计算机操作系统底层：** 内存与文件寻址建立在二进制基石之上。',
      '',
    ].join('\n')
    const doc = parse(md)
    const blocks: Array<{ type: { name: string }; textContent: string }> = []
    doc.descendants((n) => {
      blocks.push(n as never)
    })
    // 无代码块（修复前：缩进续行脱离列表 → indented code block）
    expect(blocks.some((n) => n.type.name === 'code_block')).toBe(false)
    // 公式块存在且内容正确，未吞正文
    const mathBlocks = blocks.filter((n) => n.type.name === 'math_block')
    expect(mathBlocks).toHaveLength(1)
    expect(mathBlocks[0]!.textContent).toContain('10^3')
    expect(mathBlocks[0]!.textContent).not.toContain('（就如')
    // 列表两个子项与正文段落俱在
    expect(blocks.some((n) => n.type.name === 'list_item')).toBe(true)
    expect(blocks.some((n) => n.textContent.includes('（就如 HR 谈薪资'))).toBe(true)
    expect(blocks.some((n) => n.textContent.includes('计算机操作系统底层'))).toBe(true)
  })
})
