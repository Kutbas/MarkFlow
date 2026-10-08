import { useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, rootCtx, editorViewOptionsCtx, prosePluginsCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'
import { markflowPreset } from '@markflow/shared'
import { userColor, useApp } from '../store'
import { codeBlockView, imageView, mathViews } from './views'
import { tableSourcePlugin, remoteCursorIndicator } from './table-source'
import { inplaceMarkingPlugin } from './inplace-marking'

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

/** 从协同树提取大纲（标题层级） */
function collectOutline(ydoc: Y.Doc) {
  const items: { level: number; text: string }[] = []
  const frag = ydoc.getXmlFragment('prosemirror')
  for (const child of frag.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === 'heading') {
      const level = Number(child.getAttribute('level') ?? 1)
      let text = ''
      for (const c of child.toArray()) {
        if (c instanceof Y.XmlText) text += c.toString()
      }
      if (text.trim()) items.push({ level, text: text.trim() })
    }
  }
  return items
}

/**
 * 单一 Hocuspocus 连接：由本组件创建并传给编辑器与状态订阅。
 * 外层通过 key={path} 整体重挂载实现文档切换。
 */
export function MilkdownEditor({ path, user }: { path: string; user: string }) {
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
    return () => {
      provider?.destroy()
      ydoc?.destroy()
      providerRef.current = null
      ydocRef.current = null
    }
  }, [])

  return (
    <MilkdownProvider>
      <EditorCore provider={providerRef.current} ydoc={ydocRef.current} user={user} />
    </MilkdownProvider>
  )
}

function EditorCore({
  provider,
  ydoc,
  user,
}: {
  provider: HocuspocusProvider
  ydoc: Y.Doc
  user: string
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
            inplaceMarkingPlugin,
            tableSourcePlugin,
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
