/** 标记源码展开（Typora 模型）：邻近展开为字面源码、离开合拢、符号被删保持字面 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { markSourceRevealKey, markSourceRevealPlugin, type Revealed } from '../src/components/mark-source-reveal'
import { smartToggleMark } from '../src/components/typora-keymap'
import { setPMParser, setPMSerializer } from '../src/components/pm-view'

let h: Awaited<ReturnType<typeof getHeadless>>

beforeAll(async () => {
  h = await getHeadless()
  // 宽限重解析/整跨字面走编辑器 parser/serializer 通道：测试用 headless 同构 schema 供上
  setPMParser(h.parse as never)
  setPMSerializer(h.serialize as never)
})

function stateWith(md: string, pos?: number): EditorState {
  const doc = h.parse(md) as PMNode
  const plugins = [markSourceRevealPlugin as never]
  const sel =
    pos === undefined
      ? undefined
      : TextSelection.create(doc, pos)
  return EditorState.create({ doc, plugins, selection: sel })
}

/** 状态应用后（appendTransaction 会在 apply 时级联执行）读取展开态与文本 */
function apply(st: EditorState, tr: Parameters<EditorState['apply']>[0]): EditorState {
  return st.apply(tr)
}

function docText(st: EditorState): string {
  return st.doc.textContent
}

function strongRange(st: EditorState): [number, number] | null {
  let r: [number, number] | null = null
  st.doc.descendants((n, p) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'strong') && !r) r = [p, p + n.nodeSize]
  })
  return r
}

function linkInfo(st: EditorState): { from: number; to: number; href: string } | null {
  let r: { from: number; to: number; href: string } | null = null
  st.doc.descendants((n, p) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'link') && !r) {
      const lm = n.marks.find((m) => m.type.name === 'link')
      r = { from: p, to: p + n.nodeSize, href: String(lm?.attrs?.['href'] ?? '') }
    }
  })
  return r
}

/** 以命令方式执行 smartToggleMark（等价 keymap 按键路径） */
function run(st: EditorState, markName: string): EditorState {
  let next: EditorState | null = null
  const ok = smartToggleMark(markName)(st, (tr) => {
    next = st.apply(tr)
  })
  if (!ok || !next) throw new Error('命令未执行')
  return next as EditorState
}

function revealedOf(st: EditorState): { revealed: Revealed | null } {
  return markSourceRevealKey.getState(st) as { revealed: Revealed | null }
}

describe('markSourceReveal（Typora 源码展开模型）', () => {
  it('光标紧邻加粗区（c 位）→ 展开为字面 **MM**（符号成真实字符）', () => {
    // 'XXX**MM**YYY'：MM 在 pos 4-6，c 位 pos 4
    const st = stateWith('XXX**MM**YYY\n', 4)
    // appendTransaction 已在 create 时跑过（init 后首帧？——init 不触发 append；手动触发一次）
    const st2 = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(st2)).toContain('**MM**')
    expect(strongRange(st2)).toBeNull() // 已展开：无加粗标记
  })

  it('展开后光标离开且符号完好 → 合拢回渲染态', () => {
    const st = stateWith('XXX**MM**YYY\n')
    // 光标进入 c 位（展开）
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**MM**')
    // 光标离开（文档末尾）——离展开区 ≥2
    const imploded = apply(revealed, revealed.tr.setSelection(TextSelection.create(revealed.doc, revealed.doc.content.size - 1)))
    // 合拢后：字面 ** 消失（回到标记渲染态），文本内容不变
    expect(docText(imploded)).not.toContain('**')
    expect(docText(imploded)).toContain('XXXMMYYY')
    // 合拢只还原 strong（syntax 反推 emphasis 误命中的回归防护）
    const range = strongRange(imploded)
    expect(range).not.toBeNull()
    if (range) {
      const node = imploded.doc.nodeAt(range[0])
      const names = node ? node.marks.map((m) => m.type.name) : []
      expect(names).toEqual(['strong'])
    }
    expect(strongRange(imploded)).not.toBeNull()
  })

  it('第一个 * 前输入文本 → 离开 → 正常恢复加粗（新文本留在区外）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**MM**')
    // 在第一个 * 前（pos 4）输入 A
    const typed = apply(revealed, revealed.tr.insertText('A', 4))
    expect(docText(typed)).toContain('XA**MM**')
    // 光标离开
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1)))
    expect(docText(left)).toContain('XXXAMM')
    const range = strongRange(left)
    expect(range).not.toBeNull()
    if (range) {
      const node = left.doc.nodeAt(range[0])
      expect(node?.textContent).toBe('MM')
      expect(node?.marks.map((m) => m.type.name)).toEqual(['strong'])
    }
  })

  it('最后一个 * 后输入文本 → 立即合拢（新文本在区外为普通）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    // 光标放最后一个 * 后（to=10）输入 B
    const typed = apply(revealed, revealed.tr.insertText('B', 10))
    // 光标在 B 后（to+1）→ 已在构造体外 → 合拢
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1)))
    expect(docText(left)).toContain('XXXMMB')
    const range = strongRange(left)
    expect(range).not.toBeNull()
    if (range) {
      const node = left.doc.nodeAt(range[0])
      expect(node?.textContent).toBe('MM')
    }
  })

  it('删除一个 * 后离开 → 保持字面（加粗消失，剩余符号保留）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    // 在字面 **MM** 中删掉第二个 *（位置：4=第一个*，5=第二个*，光标放 5 删左侧）
    const afterDel = apply(
      revealed,
      revealed.tr.delete(4, 5), // 删第一个 *
    )
    expect(docText(afterDel)).toContain('*MM**')
    // 光标离开
    const left = apply(
      afterDel,
      afterDel.tr.setSelection(TextSelection.create(afterDel.doc, afterDel.doc.content.size - 1)),
    )
    // 保持字面：*MM**（3 个 * 保留，无加粗标记）
    expect(docText(left)).toContain('*MM**')
    expect(strongRange(left)).toBeNull()
  })
})

describe('整跨展开（span：混合标记整跨源码显示，对齐 Typora）', () => {
  const partsOf = (st: EditorState) => {
    const parts: Array<{ text: string; names: string[] }> = []
    st.doc.descendants((n) => {
      if (n.isText) parts.push({ text: n.textContent, names: n.marks.map((m) => m.type.name) })
    })
    return parts
  }

  it('光标落尾巴段 → 整跨源码 **1. `MicroLIB` 的底层必要性**（含内嵌代码反引号）', () => {
    const st = stateWith('XXX **1. `MicroLIB` 的底层必要性** YYY\n')
    // 尾巴段 " 的底层必要性" 起于 pos 16（XXX_4 + "1. "_3 + MicroLIB_8）
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 20)))
    expect(docText(revealed)).toBe('XXX **1. `MicroLIB` 的底层必要性** YYY')
    const r = revealedOf(revealed).revealed!
    expect(r.span).toBe(true)
    expect(r.markNames).toEqual(['strong'])
    // 光标离开 → 重解析精确还原三节点结构
    const left = apply(revealed, revealed.tr.setSelection(TextSelection.create(revealed.doc, 1)))
    expect(docText(left)).toBe('XXX 1. MicroLIB 的底层必要性 YYY')
    const parts = partsOf(left)
    expect(parts.find((p) => p.text === '1. ')?.names).toEqual(['strong'])
    expect(parts.find((p) => p.text === 'MicroLIB')?.names).toContain('inlineCode')
    expect(parts.find((p) => p.text === 'MicroLIB')?.names).toContain('strong')
    expect(parts.find((p) => p.text === ' 的底层必要性')?.names).toEqual(['strong'])
  })

  it('光标落 MicroLIB 段 → 同样整跨展开', () => {
    const st = stateWith('XXX **1. `MicroLIB` 的底层必要性** YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 10)))
    expect(docText(revealed)).toBe('XXX **1. `MicroLIB` 的底层必要性** YYY')
    expect(revealedOf(revealed).revealed?.span).toBe(true)
  })

  it('整跨区空光标 Ctrl+B：加粗消失、内嵌代码存活（重解析消解）', () => {
    const st = stateWith('XXX **1. `MicroLIB` 的底层必要性** YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 20)))
    expect(revealedOf(revealed).revealed?.span).toBe(true)
    const next = run(revealed, 'strong')
    expect(docText(next)).toBe('XXX 1. MicroLIB 的底层必要性 YYY')
    const parts = partsOf(next)
    // "1. " 与左侧 XXX、尾巴与右侧 YYY 同为无标记文本被合并
    expect(parts.find((p) => p.text.includes('1. '))?.names).toEqual([])
    expect(parts.find((p) => p.text === 'MicroLIB')?.names).toEqual(['inlineCode'])
    expect(parts.find((p) => p.text.includes('底层'))?.names).toEqual([])
  })

  it('无公共标记的相邻区不生长：strong 与纯 code 边界不展开', () => {
    const st = stateWith('a **b**`c` d\n')
    // b[3,4) 与 code-c[4,5) 直接相邻：光标在边界 pos 4 → 交集空不展开
    const atBoundary = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(revealedOf(atBoundary).revealed).toBeNull()
    expect(docText(atBoundary)).toBe('a bc d')
    // 光标在 b 内（左缘 pos 3）→ 经典单标记展开（code 的 c 保持渲染态，textContent 无反引号）
    const inStrong = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 3)))
    expect(docText(inStrong)).toBe('a **b**c d')
    expect(revealedOf(inStrong).revealed?.span).toBeUndefined()
  })
})

describe('混合标记展开（strong+inlineCode：闭合反序 + 定界符间插入）', () => {
  // 夹具注意：** 前须留空格——CommonMark 侧翼规则下 XXX** 因后随标点不可开
  it('多标记字面为合法嵌套：**`MM`**（闭合反序），离开合拢双 mark 还原', () => {
    const st = stateWith('XXX **`MM`** YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 5)))
    // 闭合定界反序：**`MM`**（此前同序产出非法嵌套 **`MM**`）
    expect(docText(revealed)).toBe('XXX **`MM`** YYY')
    expect(revealedOf(revealed).revealed?.markNames).toEqual(['inlineCode', 'strong'])
    const left = apply(revealed, revealed.tr.setSelection(TextSelection.create(revealed.doc, 1)))
    expect(docText(left)).toBe('XXX MM YYY')
    const parts: Array<{ text: string; names: string[] }> = []
    left.doc.descendants((n) => {
      if (n.isText) parts.push({ text: n.textContent, names: n.marks.map((m) => m.type.name) })
    })
    const mm = parts.find((p) => p.text === 'MM')
    expect(mm?.names).toHaveLength(2)
    expect(mm?.names).toContain('strong')
    expect(mm?.names).toContain('inlineCode')
  })

  it('定界符之间插入 "1. "（** 与 ` 之间）→ 离开按 markdown 重解析（用户实测：1. 在行内代码外、加粗内）', () => {
    const st = stateWith('XXX **`MM`** YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 5)))
    // 在 **（[5,7)）与反引号（pos 7）之间插入 "1. "
    const typed = apply(revealed, revealed.tr.insertText('1. ', 7))
    expect(docText(typed)).toBe('XXX **1. `MM`** YYY')
    expect(revealedOf(typed).revealed).not.toBeNull()
    const left = apply(typed, typed.tr.setSelection(TextSelection.create(typed.doc, 1)))
    // 宽限重解析：strong("1. ") + strong+code("MM")，无字面符号
    expect(docText(left)).toBe('XXX 1. MM YYY')
    expect(revealedOf(left).revealed).toBeNull()
    const parts: Array<{ text: string; names: string[] }> = []
    left.doc.descendants((n) => {
      if (n.isText) parts.push({ text: n.textContent, names: n.marks.map((m) => m.type.name) })
    })
    const prefix = parts.find((p) => p.text === '1. ')
    expect(prefix?.names).toEqual(['strong'])
    const mm = parts.find((p) => p.text === 'MM')
    expect(mm?.names).toHaveLength(2)
    expect(mm?.names).toContain('strong')
    expect(mm?.names).toContain('inlineCode')
  })

  it('删除开定界 ** → 重解析有无标记残留，保持字面（真破形回归）', () => {
    const st = stateWith('XXX **`MM`** YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 5)))
    const afterDel = apply(revealed, revealed.tr.delete(5, 7)) // 删 `**`
    expect(docText(afterDel)).toBe('XXX `MM`** YYY')
    const left = apply(afterDel, afterDel.tr.setSelection(TextSelection.create(afterDel.doc, 1)))
    // `MM`** 解析出 code("MM") + 无标记 "**" 残留 → 拒绝，保持字面
    expect(docText(left)).toBe('XXX `MM`** YYY')
    expect(revealedOf(left).revealed).toBeNull()
  })
})

describe('展开态格式快捷键（smartToggleMark 感知 revealed）', () => {

  it('标题内 Ctrl+B 两次 → 加粗后可撤销：字面 ** 出现又消失（回归：此前第二次把 ** 本身加粗）', () => {
    // 光标在标题文本中间（pos 3 = 标|题文本 之间）
    const st = stateWith('# 标题文本\n', 3)
    const once = run(st, 'strong')
    expect(docText(once)).toContain('**标题文本**')
    expect(revealedOf(once).revealed).not.toBeNull()
    const twice = run(once, 'strong')
    expect(docText(twice)).toContain('标题文本')
    expect(docText(twice)).not.toContain('*')
    expect(revealedOf(twice).revealed).toBeNull()
    expect(strongRange(twice)).toBeNull()
  })

  it('加粗+斜体展开态去掉 strong → 字面变 *MM*，斜体保留', () => {
    const st = stateWith('XXX***MM***YYY\n')
    // 光标 c 位（pos 4）→ 展开为字面 ***MM***
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('***MM***')
    const next = run(revealed, 'strong')
    expect(docText(next)).toContain('*MM*')
    expect(docText(next)).not.toContain('***')
    expect(revealedOf(next).revealed?.markNames).toEqual(['emphasis'])
  })

  it('加粗展开态叠加 emphasis → 字面变 ***MM***（区域保持展开）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const next = run(revealed, 'emphasis')
    expect(docText(next)).toContain('***MM***')
    expect(revealedOf(next).revealed?.markNames).toEqual(['strong', 'emphasis'])
  })

  it('选区覆盖展开区 Ctrl+B → 区域级消解为纯文本', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const r = revealedOf(revealed).revealed!
    // 选区恰好覆盖字面 **MM**
    const selected = apply(
      revealed,
      revealed.tr.setSelection(TextSelection.create(revealed.doc, r.from, r.to)),
    )
    const next = run(selected, 'strong')
    expect(docText(next)).toContain('XXXMMYYY')
    expect(docText(next)).not.toContain('*')
    expect(revealedOf(next).revealed).toBeNull()
  })

  it('符号已破形（删过一个 *）→ 不接管，走普通词级逻辑（现状不变）', () => {
    const st = stateWith('XXX**MM**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const afterDel = apply(revealed, revealed.tr.delete(4, 5)) // *MM** 破形
    const next = run(afterDel, 'strong')
    // 未接管：破形字面文本被整体加粗（无区域消解、revealed 保留）
    expect(docText(next)).toContain('*MM**')
    expect(strongRange(next)).not.toBeNull()
    expect(revealedOf(next).revealed).not.toBeNull()
  })

  it('展开区内子选区 Ctrl+E → 合拢后只给选区加 code（不扩展到全区域，回归）', () => {
    const st = stateWith('XXX**MicroLIB 的底层必要性**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**MicroLIB 的底层必要性**')
    const r = revealedOf(revealed).revealed!
    // 选中字面内容里的 "MicroLIB" 子串（内容起点 = r.from + 前缀 '**'）
    const selected = apply(
      revealed,
      revealed.tr.setSelection(TextSelection.create(revealed.doc, r.from + 2, r.from + 2 + 'MicroLIB'.length)),
    )
    const next = run(selected, 'inlineCode')
    // 区域已合拢：无字面符号、revealed 清空
    expect(docText(next)).not.toContain('*')
    expect(docText(next)).toContain('XXXMicroLIB 的底层必要性YYY')
    expect(revealedOf(next).revealed).toBeNull()
    // "MicroLIB" = strong+inlineCode；其余仅 strong
    const parts: Array<{ text: string; names: string[] }> = []
    next.doc.descendants((n) => {
      if (n.isText) parts.push({ text: n.textContent, names: n.marks.map((m) => m.type.name) })
    })
    const lib = parts.find((p) => p.text === 'MicroLIB')
    expect(lib?.names).toHaveLength(2)
    expect(lib?.names).toContain('strong')
    expect(lib?.names).toContain('inlineCode')
    const rest = parts.find((p) => p.text.includes('底层'))
    expect(rest?.names).toEqual(['strong'])
  })

  it('展开区内子选区 Ctrl+B → 合拢后仅选区取消加粗，其余保留', () => {
    const st = stateWith('XXX**MicroLIB 的底层必要性**YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const r = revealedOf(revealed).revealed!
    const selected = apply(
      revealed,
      revealed.tr.setSelection(TextSelection.create(revealed.doc, r.from + 2, r.from + 2 + 'MicroLIB'.length)),
    )
    const next = run(selected, 'strong')
    expect(docText(next)).not.toContain('*')
    expect(revealedOf(next).revealed).toBeNull()
    const parts: Array<{ text: string; names: string[] }> = []
    next.doc.descendants((n) => {
      if (n.isText) parts.push({ text: n.textContent, names: n.marks.map((m) => m.type.name) })
    })
    const lib = parts.find((p) => p.text.includes('MicroLIB'))
    // 取消加粗后与左侧同为无标记的 XXX 合并成一个文本节点
    expect(lib?.text).toBe('XXXMicroLIB')
    expect(lib?.names).toEqual([])
    const rest = parts.find((p) => p.text.includes('底层'))
    expect(rest?.names).toEqual(['strong'])
  })
})

describe('超链接源码展开（点击进入 [文本](地址)，离开合拢）', () => {
  it('光标进入链接区 → 展开为字面 [Google](https://g.com)', () => {
    const st = stateWith('XXX[Google](https://g.com)YYY\n')
    expect(linkInfo(st)?.href).toBe('https://g.com') // 前置：解析出 link mark
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('[Google](https://g.com)')
    expect(linkInfo(revealed)).toBeNull() // 已展开：无 link 标记
  })

  it('光标离开且结构完好 → 合拢回 link mark（href 正确）', () => {
    const st = stateWith('XXX[Google](https://g.com)YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const left = apply(
      revealed,
      revealed.tr.setSelection(TextSelection.create(revealed.doc, revealed.doc.content.size - 1)),
    )
    expect(docText(left)).toContain('XXXGoogleYYY')
    const li = linkInfo(left)
    expect(li).not.toBeNull()
    expect(li?.href).toBe('https://g.com')
  })

  it('字面里改 URL 后离开 → 合拢用新地址（改字面即改链接）', () => {
    const st = stateWith('XXX[Google](https://g.com)YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const r = revealedOf(revealed).revealed!
    const text = revealed.doc.textBetween(r.from, r.to, '\n', ' ')
    // 替换 href 整段（最后一个 '(' 之后到字面末尾 ')' 之前）
    const hrefStart = r.from + text.lastIndexOf('(') + 1
    const hrefEnd = r.to - 1
    const changed = apply(revealed, revealed.tr.delete(hrefStart, hrefEnd).insertText('https://x.io', hrefStart))
    expect(docText(changed)).toContain('[Google](https://x.io)')
    const left = apply(
      changed,
      changed.tr.setSelection(TextSelection.create(changed.doc, changed.doc.content.size - 1)),
    )
    expect(linkInfo(left)?.href).toBe('https://x.io')
  })

  it('删除括号破形 → 保持字面', () => {
    const st = stateWith('XXX[Google](https://g.com)YYY\n')
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    const r = revealedOf(revealed).revealed!
    const text = revealed.doc.textBetween(r.from, r.to, '\n', ' ')
    const parenPos = r.from + text.lastIndexOf('(')
    const broken = apply(revealed, revealed.tr.delete(parenPos, parenPos + 1))
    const left = apply(
      broken,
      broken.tr.setSelection(TextSelection.create(broken.doc, broken.doc.content.size - 1)),
    )
    expect(docText(left)).toContain('[Google]https://g.com)')
    expect(linkInfo(left)).toBeNull()
  })

  it('加粗链接 **[G](u)**：展开/合拢双 mark 还原；展开态 Cmd+B → 撤销加粗保留链接', () => {
    // headless 解析 **[链接](…)** 有方言差异（不叠 strong）——用 schema 直接构造双标记
    const base = EditorState.create({ doc: h.parse('XXXGYYY\n') as PMNode })
    const marked = base.tr
      .addMark(4, 5, base.schema.marks['link']!.create({ href: 'https://g.com' }))
      .addMark(4, 5, base.schema.marks['strong']!.create())
    const st = EditorState.create({
      doc: marked.doc,
      plugins: [markSourceRevealPlugin as never],
    })
    const revealed = apply(st, st.tr.setSelection(TextSelection.create(st.doc, 4)))
    expect(docText(revealed)).toContain('**[G](https://g.com)**')
    // 合拢：strong + link 双还原
    const left = apply(
      revealed,
      revealed.tr.setSelection(TextSelection.create(revealed.doc, revealed.doc.content.size - 1)),
    )
    expect(strongRange(left)).not.toBeNull()
    expect(linkInfo(left)?.href).toBe('https://g.com')
    // 展开态撤销加粗：字面变 [G](https://g.com)，链接结构保留
    const revealed2 = apply(left, left.tr.setSelection(TextSelection.create(left.doc, 4)))
    const unbold = run(revealed2, 'strong')
    expect(docText(unbold)).toContain('[G](https://g.com)')
    expect(docText(unbold)).not.toContain('**')
    expect(revealedOf(unbold).revealed?.markNames).toEqual(['link'])
  })
})
