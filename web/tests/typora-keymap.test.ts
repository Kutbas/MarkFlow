import { beforeAll, describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { getHeadless } from '@markflow/shared/headless'
import { toggleTaskList, typoraShortcuts } from '../src/components/typora-keymap'

/** 构造最小 view 替身：真实 EditorState（完整 Transaction 能力） */
function makeView(doc: PMNode) {
  let pos = -1
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && (node.text ?? '').startsWith('正文')) pos = p
    return pos < 0
  })
  if (pos < 0) pos = 1
  const view = {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, pos) }),
    dispatch(tr: Parameters<EditorState['apply']>[0]) {
      view.state = view.state.apply(tr)
    },
    focus: () => {},
    dom: document.createElement('div'),
  }
  return {
    view,
    cursorBlock: () => view.state.selection.$from.parent.type.name,
  }
}

const MD = '# 标题\n\n正文段落文字。\n'

let parsed: PMNode

beforeAll(async () => {
  const { parse } = await getHeadless()
  parsed = parse(MD)
})

function run(key: string, doc: PMNode) {
  const { view, cursorBlock } = makeView(doc)
  const cmd = typoraShortcuts[key]!
  const ok = cmd(view.state as never, view.dispatch as never, view as never)
  return { ok, view, cursorBlock }
}

describe('typora-keymap 命令', () => {
  it('Mod-1~6：段落转对应级别标题', async () => {
    const { parse } = await getHeadless()
    const doc = parse('正文段落。\n')
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const r = run(`Mod-${level}`, doc)
      expect(r.ok, `Mod-${level}`).toBe(true)
      expect(r.cursorBlock()).toBe('heading')
      const h = r.view.state.doc.firstChild!
      expect(h.attrs['level']).toBe(level)
    }
  })

  it('Mod-0：标题/代码块/公式块转回段落', async () => {
    const { parse } = await getHeadless()
    for (const md of ['# 标题\n', '```\ncode\n```\n', '$$\nE=mc\n$$\n']) {
      const r = run('Mod-0', parse(md))
      expect(r.ok, md).toBe(true)
      expect(r.cursorBlock()).toBe('paragraph')
    }
  })

  it('代码块：Mod-Alt-k 与 Mod-Shift-k 双绑定都转 code_block', async () => {
    const { parse } = await getHeadless()
    for (const key of ['Mod-Alt-k', 'Mod-Shift-k']) {
      const r = run(key, parse('正文段落。\n'))
      expect(r.ok, key).toBe(true)
      expect(r.view.state.doc.firstChild!.type.name).toBe('code_block')
    }
  })

  it('公式块：Mod-Shift-m 转 math_block', async () => {
    const { parse } = await getHeadless()
    const r = run('Mod-Shift-m', parse('正文段落。\n'))
    expect(r.ok).toBe(true)
    expect(r.view.state.doc.firstChild!.type.name).toBe('math_block')
  })

  it('行内代码：Ctrl-` 与 Mod-Shift-` 普通文本整行应用（Typora 交互）', async () => {
    const { parse } = await getHeadless()
    for (const key of ['Ctrl-`', 'Mod-Shift-`']) {
      const { view } = makeView(parse('正文段落。\n'))
      expect(typoraShortcuts[key]!(view.state as never, view.dispatch as never, view as never), key).toBe(true)
      let marked = false
      view.state.doc.descendants((n) => {
        if (n.isText && n.marks.some((m) => m.type.name === 'inlineCode')) marked = true
      })
      expect(marked, key).toBe(true)
    }
  })

  it('删除线：Mod-Shift-s 普通文本整行应用（Typora 交互）', async () => {
    const { parse } = await getHeadless()
    const { view } = makeView(parse('正文段落。\n'))
    expect(typoraShortcuts['Mod-Shift-s']!(view.state as never, view.dispatch as never, view as never)).toBe(true)
    let marked = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strike_through')) marked = true
    })
    expect(marked).toBe(true)
  })

  it('删除线：光标在删除线内直接取消整段（smart 版）', async () => {
    const { parse } = await getHeadless()
    const doc = parse('~~删除线文本~~\n') as PMNode
    let pos = 1
    doc.descendants((n, p) => {
      if (pos === 1 && n.isText && n.marks.some((m) => m.type.name === 'strike_through')) pos = p + 2
      return pos === 1
    })
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
    const v = { state: st, dispatch: (tr: Parameters<EditorState['apply']>[0]) => { v.state = v.state.apply(tr) }, focus: () => {} }
    expect(typoraShortcuts['Mod-Shift-s']!(v.state as never, v.dispatch as never, v as never)).toBe(true)
    let hasStrike = false
    v.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'strike_through')) hasStrike = true
    })
    expect(hasStrike).toBe(false)
  })

  it('引用与列表：wrap 当前块（含 Alt 版列表绑定）', async () => {
    const { parse } = await getHeadless()
    const bq = run('Mod-Shift-q', parse('正文段落。\n'))
    expect(bq.ok).toBe(true)
    expect(bq.view.state.doc.firstChild!.type.name).toBe('blockquote')

    // mac 上 Cmd+Shift+]/[ 被 Chrome 占用 → Alt 版绑定（Mod-Alt-]/[）
    const ul = run('Mod-Shift-]', parse('正文段落。\n'))
    expect(ul.ok).toBe(true)
    expect(ul.view.state.doc.firstChild!.type.name).toBe('bullet_list')

    const ol = run('Mod-Shift-[', parse('正文段落。\n'))
    expect(ol.ok).toBe(true)
    expect(ol.view.state.doc.firstChild!.type.name).toBe('ordered_list')

    const ulAlt = run('Mod-Alt-]', parse('正文段落。\n'))
    expect(ulAlt.ok).toBe(true)
    expect(ulAlt.view.state.doc.firstChild!.type.name).toBe('bullet_list')

    const olAlt = run('Mod-Alt-[', parse('正文段落。\n'))
    expect(olAlt.ok).toBe(true)
    expect(olAlt.view.state.doc.firstChild!.type.name).toBe('ordered_list')
  })

  it('标题升降级：Mod-= 升、Mod-- 降，段落升级为 H6', async () => {
    const { parse } = await getHeadless()
    const h3 = parse('### 标题\n')
    const up = run('Mod-=', h3)
    expect(up.ok).toBe(true)
    expect(up.view.state.doc.firstChild!.attrs['level']).toBe(2)

    const down = run('Mod--', h3)
    expect(down.ok).toBe(true)
    expect(down.view.state.doc.firstChild!.attrs['level']).toBe(4)

    // 段落升级 → H6；段落降级 → 不处理（返回 false）
    const p6 = run('Mod-=', parse('正文。\n'))
    expect(p6.ok).toBe(true)
    expect(p6.view.state.doc.firstChild!.attrs['level']).toBe(6)
    const noDown = run('Mod--', parse('正文。\n'))
    expect(noDown.ok).toBe(false)

    // H1 再升 / H6 再降 → 无变化返回 false
    const top = run('Mod-=', parse('# 标题\n'))
    expect(top.ok).toBe(false)
    const bottom = run('Mod--', parse('###### 标题\n'))
    expect(bottom.ok).toBe(false)
  })

  it('任务列表：段落→任务项→普通项 往返；已在列表→切换 checked', async () => {
    const { parse } = await getHeadless()
    // 段落 → 任务项（wrap bullet_list + checked=false）
    const { view } = makeView(parse('正文段落。\n'))
    expect(toggleTaskList(view.state as never, view.dispatch as never, view as never)).toBe(true)
    const list = view.state.doc.firstChild!
    expect(list.type.name).toBe('bullet_list')
    const item = list.firstChild!
    expect(item.type.name).toBe('list_item')
    expect(item.attrs['checked']).toBe(false)

    // 任务项 → 普通项（checked=null）
    expect(toggleTaskList(view.state as never, view.dispatch as never, view as never)).toBe(true)
    expect(view.state.doc.firstChild!.firstChild!.attrs['checked']).toBe(null)

    // 普通列表项 → 任务项
    expect(toggleTaskList(view.state as never, view.dispatch as never, view as never)).toBe(true)
    expect(view.state.doc.firstChild!.firstChild!.attrs['checked']).toBe(false)

    // 有序列表项同理可转任务
    const ol = makeView(parse('1. 正文段落。\n'))
    expect(toggleTaskList(ol.view.state as never, ol.view.dispatch as never, ol.view as never)).toBe(true)
    let olItem: PMNode | null = null
    ol.view.state.doc.descendants((n) => {
      if (!olItem && n.type.name === 'list_item') olItem = n
    })
    expect(olItem).toBeTruthy()
  })
})
