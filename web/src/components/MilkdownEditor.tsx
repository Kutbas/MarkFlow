import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, editorViewOptionsCtx, prosePluginsCtx, editorViewCtx, parserCtx } from '@milkdown/kit/core'
import { TextSelection } from '@milkdown/kit/prose/state'

/** 方向键逃逸监听的卸载函数（防重复挂载） */
const arrowEscapeDetach: Array<() => void> = []

/** 新建文档正文聚焦的轮询单飞守卫（防渲染风暴下多条并发链） */
let focusBodyInFlight = false
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { markflowPreset } from '@markflow/shared'
import { userColor, useApp } from '../store'
import { codeBlockView, imageView, mathViews } from './views'
import { remoteCursorIndicator } from './table-source'
import { initTableToolbar } from './table-toolbar'
import { getPMView, setPMParser, setPMView } from './pm-view'
import { inplaceMarkingPlugin } from './inplace-marking'
import { mdPastePlugin } from './md-paste'
import { linkOpenPlugin } from './link-open'
import { taskClickToggle } from './task-click'
import { typoraKeymapPlugin, attachArrowEscape } from './typora-keymap'
import { listInputGuard } from './list-input-guard'

function collabWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/collab`
}

/** Awareness 状态表（v4 类型上可能为 null，构造后必有实例） */
function awarenessStates(provider: HocuspocusProvider) {
  return (provider.awareness ?? { getStates: () => new Map() }).getStates() as Map<
    number,
    { user?: { name: string; color?: string } }
  >
}

/** 收集当前文档的在线协作者（Awareness user 字段） */
function collectOnlineUsers(provider: HocuspocusProvider) {
  const seen = new Map<number, { name: string; color: string; clientId: number }>()
  for (const [clientId, state] of awarenessStates(provider)) {
    const u = state.user
    if (!u) continue
    seen.set(clientId, {
      name: u.name,
      color: u.color ?? userColor(u.name),
      clientId,
    })
  }
  return [...seen.values()]
}

/** 从协同树提取大纲（标题层级 + 顶层标题序号，供跳转按序定位） */
function collectOutline(ydoc: Y.Doc) {
  const items: { level: number; text: string; index: number }[] = []
  const frag = ydoc.getXmlFragment('prosemirror')
  let headingSeq = 0
  for (const child of frag.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === 'heading') {
      const level = Number(child.getAttribute('level') ?? 1)
      let text = ''
      const collectText = (node: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
        if (node instanceof Y.XmlText) {
          // toString() 是 XML 序列化（会带 <inlineCode> 等字面标签），delta 才是纯文本
          for (const d of node.toDelta()) {
            if (typeof d.insert === 'string') text += d.insert
          }
        } else if (node instanceof Y.XmlElement) {
          for (const c of node.toArray()) collectText(c)
        }
      }
      collectText(child)
      if (text.trim()) items.push({ level, text: text.trim(), index: headingSeq })
      headingSeq++
    }
  }
  return items
}

/**
 * 单一 Hocuspocus 连接：由本组件创建并传给编辑器与状态订阅。
 * 外层通过 key={path} 整体重挂载实现文档切换。
 */
export function MilkdownEditor({
  path,
  user,
  onReady,
}: {
  path: string
  user: string
  onReady?: () => void
}) {
  const providerRef = useRef<HocuspocusProvider | null>(null)
  const ydocRef = useRef<Y.Doc | null>(null)

  if (!providerRef.current || !ydocRef.current) {
    const ydoc = new Y.Doc()
    providerRef.current = new HocuspocusProvider({
      url: collabWsUrl(),
      name: path,
      document: ydoc,
    })
    ydocRef.current = ydoc
  }

  useEffect(() => {
    const provider = providerRef.current
    const ydoc = ydocRef.current
    ;(window as unknown as { __mfDebug?: unknown }).__mfDebug = { provider, ydoc, path }

    // 真实加载进度：累计服务端下发的协同数据字节（二进制帧）
    const setDocProgress = useApp.getState().setDocProgress
    const onWsMessage = (ev: { data?: unknown }) => {
      const data = ev.data
      let bytes = 0
      if (data instanceof ArrayBuffer) bytes = data.byteLength
      else if (data instanceof Uint8Array) bytes = data.byteLength
      else if (typeof data === 'string') bytes = data.length
      if (bytes > 0) {
        const cur = useApp.getState().docProgress
        setDocProgress({ received: cur.received + bytes, phase: cur.phase === 'connecting' ? 'syncing' : cur.phase })
      }
    }
    provider?.on('synced', () => setDocProgress({ phase: 'rendering' }))
    provider?.on('message', onWsMessage as never)

    return () => {
      provider?.off('message', onWsMessage as never)
      provider?.destroy()
      ydoc?.destroy()
      providerRef.current = null
      ydocRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <MilkdownProvider>
      <EditorCore provider={providerRef.current} ydoc={ydocRef.current} user={user} onReady={onReady} />
    </MilkdownProvider>
  )
}

function EditorCore({
  provider,
  ydoc,
  user,
  onReady,
}: {
  provider: HocuspocusProvider
  ydoc: Y.Doc
  user: string
  onReady?: () => void
}) {
  const setDocStatus = useApp((s) => s.setDocStatus)
  const setOnlineUsers = useApp((s) => s.setOnlineUsers)
  const setOutline = useApp((s) => s.setOutline)

  const { loading, get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root)
          ctx.set(editorViewOptionsCtx, { attributes: { spellcheck: 'false' } })
        })
        .use(commonmark)
        .use(gfm)
        .use(markflowPreset)
        .use(codeBlockView)
        .use(imageView)
        .use(mathViews)
        .use(collab)
        .config((ctx) => {
          ctx.update(prosePluginsCtx, (plugins) => [
            ...plugins,
            ...typoraKeymapPlugin(),
            listInputGuard,
            inplaceMarkingPlugin,
            mdPastePlugin,
            linkOpenPlugin,
            taskClickToggle,
            ...(provider.awareness ? [remoteCursorIndicator(provider.awareness)] : []),
          ])
        }),
    [],
  )

  // 编辑器就绪 → 接入协同（绑定 Y.Doc + Awareness + 光标插件）
  useEffect(() => {
    if (loading) return
    const editor = get()
    if (!editor || !provider.awareness) return
    provider.awareness.setLocalStateField('user', {
      name: user,
      color: userColor(user),
    })
    editor.action((ctx) => {
      ctx.get(collabServiceCtx).bindDoc(ydoc).setAwareness(provider.awareness!).connect()
      // 存 PM view / parser 供工具栏等 UI 组件使用（parser 必须与编辑器同一 schema 实例）
      setPMView(ctx.get(editorViewCtx))
      setPMParser(ctx.get(parserCtx))
      initTableToolbar()
      // 方向键边界逃逸（加粗/代码等行内格式的 ➡️⬅️ 手感）：document 捕获监听
      arrowEscapeDetach.forEach((d) => d())
      arrowEscapeDetach.length = 0
      arrowEscapeDetach.push(attachArrowEscape(() => getPMView() as never))
      // 新建文档：等内容经协同同步到达后，光标落标题后的正文段落并聚焦
      // ——新建即可直接写正文（标题回车续写，正文开箱即写）
      // 新建文档：等内容经协同同步到达后，光标落标题后的正文段落并聚焦
      // ——新建即可直接写正文。单飞守卫：本 effect 在渲染风暴里会重跑多次
      // （useEditor 的 get 引用不稳），无守卫时会创建多条并发轮询链互相踩踏
      if (
        useApp.getState().pendingTitleFocus !== null &&
        useApp.getState().pendingTitleFocus === useApp.getState().currentPath &&
        !focusBodyInFlight
      ) {
        focusBodyInFlight = true
        const tryFocusBody = (attempts: number): void => {
          // 其他链/本链已完成落位：立即退场（finally 复位守卫）
          if (useApp.getState().pendingTitleFocus === null) return
          const view = getPMView() as
            | {
                state: {
                  doc: {
                    firstChild: { type: { name: string }; nodeSize: number; nextSibling: { type: { name: string } } | null } | null
                  }
                  schema: { nodes: Record<string, { createAndFill(): unknown }> }
                  tr: {
                    insert(pos: number, node: unknown): unknown
                    setSelection(s: unknown): unknown
                    doc: unknown
                  }
                }
                dispatch(t: unknown): void
                focus(): void
              }
            | null
          let done = false
          try {
            const first = view?.state?.doc?.firstChild
            if (view && first && first.type.name === 'heading') {
              // 不能对"标题后一位置"盲 resolve——协同播种后文档常只有标题
              // （md 解析丢模板尾空段），越界 resolve 直接抛 RangeError
              const after = first.nextSibling
              const paraType = view.state.schema.nodes['paragraph']
              if (after && after.type.name === 'paragraph') {
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc as never, first.nodeSize + 1)))
                view.focus()
                done = true
              } else if (!after && paraType) {
                // 只有标题：补一个空段落作为正文落点，光标置其中
                const tr = view.state.tr.insert(first.nodeSize, paraType.createAndFill())
                const tr2 = (tr as unknown as { setSelection(s: unknown): unknown }).setSelection(
                  TextSelection.create((tr as unknown as { doc: unknown }).doc as never, first.nodeSize + 1),
                )
                view.dispatch(tr2)
                view.focus()
                done = true
              }
            }
          } finally {
            if (done || attempts <= 0) {
              // 完成（或放弃）：清标记 + 复位单飞守卫
              useApp.getState().setPendingTitleFocus(null)
              focusBodyInFlight = false
              return
            }
          }
          setTimeout(() => tryFocusBody(attempts - 1), 100)
        }
        setTimeout(() => tryFocusBody(30), 100)
      }
      // 渲染就绪：PM 初次渲染（可能阻塞主线程数秒）恢复后的第一个 rAF
      requestAnimationFrame(() => {
        useApp.getState().setDocProgress({ phase: 'ready' })
        onReady?.()
      })
    })
  }, [loading, get, provider, ydoc, user])

  // 状态 / 协作者 / 大纲订阅
  useEffect(() => {
    const onStatus = ({ status }: { status: string }) => {
      if (status === 'synced' || status === 'connected') setDocStatus('synced')
      else setDocStatus('connecting')
    }
    const onSynced = () => setDocStatus('synced')
    const onAwareness = () => setOnlineUsers(collectOnlineUsers(provider))

    let outlineTimer = 0
    const onUpdate = () => {
      window.clearTimeout(outlineTimer)
      outlineTimer = window.setTimeout(() => setOutline(collectOutline(ydoc)), 300)
    }

    provider.on('status', onStatus as never)
    provider.on('synced', onSynced as never)
    provider.on('awarenessUpdate', onAwareness)
    ydoc.on('update', onUpdate)

    return () => {
      provider.off('status', onStatus as never)
      provider.off('synced', onSynced as never)
      provider.off('awarenessUpdate', onAwareness)
      ydoc.off('update', onUpdate)
      window.clearTimeout(outlineTimer)
    }
  }, [provider, ydoc, setDocStatus, setOnlineUsers, setOutline])

  return <Milkdown />
}
