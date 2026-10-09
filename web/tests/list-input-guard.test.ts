import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { listGuardRules } from '../src/components/list-input-guard'

/** InputRule 的内部结构：{ match, handler }（prosemirror 未导出类型，按鸭子类型取用） */
type Rule = { match: RegExp; handler: (state: never, match: RegExpMatchArray, from: number, to: number) => unknown }
const rules = listGuardRules as unknown as Rule[]

function stateAtStart(md: string, h: Awaited<ReturnType<typeof getHeadless>>): EditorState {
  const doc = h.parse(md) as PMNode
  return EditorState.create({ doc, selection: TextSelection.create(doc, 2) })
}

describe('列表输入守卫（仅整行加粗时拦截转换）', () => {
  it('注册了有序/无序两条守卫规则', () => {
    expect(rules.length).toBe(2)
  })

  it('整行加粗：拦截（返回插入空格的 tr）', async () => {
    const h = await getHeadless()
    const numbered = rules[0]!
    const match = /^\s*(\d+)\.\s$/.exec('1. ')!
    expect(numbered.handler(stateAtStart('**整行加粗**\n', h) as never, match, 1, 1)).toBeTruthy()
  })

  it('部分加粗：放行（返回 null，正常变列表）', async () => {
    const h = await getHeadless()
    const numbered = rules[0]!
    const match = /^\s*(\d+)\.\s$/.exec('1. ')!
    expect(numbered.handler(stateAtStart('**加粗**普通文本\n', h) as never, match, 1, 1)).toBeNull()
  })

  it('开头加粗后接普通：放行', async () => {
    const h = await getHeadless()
    const numbered = rules[0]!
    const match = /^\s*(\d+)\.\s$/.exec('1. ')!
    expect(numbered.handler(stateAtStart('**加粗开头** 后面普通\n', h) as never, match, 1, 1)).toBeNull()
  })

  it('无格式：放行', async () => {
    const h = await getHeadless()
    const numbered = rules[0]!
    const match = /^\s*(\d+)\.\s$/.exec('1. ')!
    expect(numbered.handler(stateAtStart('普通文本\n', h) as never, match, 1, 1)).toBeNull()
  })

  it('无序守卫同逻辑（整行加粗拦截，否则放行）', async () => {
    const h = await getHeadless()
    const bullet = rules[1]!
    const match = /^\s*[-*+]\s$/.exec('- ')!
    expect(bullet.handler(stateAtStart('**加粗**\n', h) as never, match, 1, 1)).toBeTruthy()
    expect(bullet.handler(stateAtStart('**部分**加粗\n', h) as never, match, 1, 1)).toBeNull()
  })
})
