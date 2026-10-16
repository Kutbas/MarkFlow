/**
 * 转义输入（Typora 行为）：在渲染视图输入 `\` + 特殊字符（* ` ~ _ \）时，
 * 反斜杠被消耗、特殊字符以原生形态插入——`\*` 打出来就是一个普通的 `*`，
 * 不触发任何格式输入规则。存储层由序列化器负责再转义（\*），往返无损。
 * 在源码展开态（markSourceReveal 激活且光标在展开区内）不转换——
 * 源码视图里 `\*` 保持字面（这正是源码里写转义的方式）。
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

const ESCAPABLE_INPUT = new Set(['*', '`', '~', '_', '\\'])
const REVEAL_KEY_ID = 'mfMarkSourceReveal'

export const escapeInputKey = new PluginKey('mfEscapeInput')

export const escapeInputPlugin = new Plugin({
  key: escapeInputKey,
  props: {
    handleTextInput: (view, from, to, text) => {
      if (!ESCAPABLE_INPUT.has(text)) return false
      const state = (
        view as unknown as {
          state: {
            doc: { textBetween(f: number, t: number, a: string, b: string): string }
          }
          dispatch(t: unknown): void
        }
      ).state as never as {
        doc: { textBetween(f: number, t: number, a: string, b: string): string }
        tr: { insertText(t: string, f: number, to: number): unknown }
      }
      // 前一字符必须是未消耗的反斜杠
      if (from === 0) return false
      const before = state.doc.textBetween(from - 1, from, '\n', ' ')
      if (before !== '\\') return false

      // 源码展开态内不转换（光标在展开区 = 正在编辑源码，\* 是有意写的转义）
      const revealed = getRevealed(view)
      if (revealed && from >= revealed.from && from <= revealed.to) return false

      const dispatch = (view as unknown as { dispatch(t: unknown): void }).dispatch
      // 消耗 \ 并以原生字符插入（替换 [from-1, to)，吞掉反斜杠）
      dispatch(state.tr.insertText(text, from - 1, to))
      return true
    },
  },
})

/** 读取 markSourceReveal 插件的展开态（插件状态按 key 查询，无模块硬依赖） */
function getRevealed(view: unknown): { from: number; to: number } | null {
  const state = (view as unknown as { state: Parameters<import('@milkdown/kit/prose/state').EditorState['apply']>[0] & Record<string, never> }).state
  try {
    const key = (state as unknown as { plugins: Array<{ key?: { key?: string } }> }).plugins?.find(
      (p) => p.key?.key === REVEAL_KEY_ID,
    )
    if (!key) return null
    const s = (key as unknown as { getState(st: unknown): { revealed?: { from: number; to: number } | null } }).getState(state)
    return s?.revealed ?? null
  } catch {
    return null
  }
}
