/**
 * 列表输入守卫：段落"序号之后的原文本"整段全部加粗时，"1. " / "- " 等
 * 序号输入不触发列表转换（Typora 用户惯例——整行强调文本前的序号是正文
 * 一部分）；部分加粗或无格式的段落照常触发内置列表 inputrule。
 * 判定范围排除刚输入的序号前缀（光标 from 之前），只看其后原有内容。
 */
import { InputRule, inputRules } from '@milkdown/kit/prose/inputrules'
import type { EditorState } from '@milkdown/kit/prose/state'

/** 序号前缀（from）之后的段落内容是否全部为加粗文本 */
function tailIsEntirelyStrong(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from)
  const para = $from.parent
  const relFrom = from - $from.start() // from 在段落内容内的偏移
  let hasText = false
  let allStrong = true
  let offset = 0
  para.forEach((n) => {
    if (n.isText && n.text && offset + n.nodeSize > relFrom) {
      hasText = true
      if (!n.marks.some((m) => m.type.name === 'strong')) allStrong = false
    }
    offset += n.nodeSize
  })
  return hasText && allStrong
}

/** 命中且尾部整行加粗 → 插入空格（默认输入效果）；否则 null 放行内置规则 */
function guard(matchAll: RegExp): InputRule {
  return new InputRule(matchAll, (state, _match, from, to) => {
    if (!tailIsEntirelyStrong(state, from)) return null
    return state.tr.insertText(' ', to)
  })
}

/** 守卫规则（导出供测试） */
export const listGuardRules: InputRule[] = [
  guard(/^\s*(\d+)\.\s$/), // 有序列表
  guard(/^\s*[-*+]\s$/), // 无序列表
]

export const listInputGuard = inputRules({ rules: listGuardRules })
