import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useApp } from '../store'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { MilkdownEditor } from './MilkdownEditor'

/** 应用主工作区：左侧文件树/大纲，右侧编辑器 */
export function Workspace() {
  const user = useApp((s) => s.user)
  const setTree = useApp((s) => s.setTree)
  const setThemes = useApp((s) => s.setThemes)
  const currentPath = useApp((s) => s.currentPath)
  const setCurrentPath = useApp((s) => s.setCurrentPath)
  const tree = useApp((s) => s.tree)
  const refreshTimer = useRef<number | null>(null)
  // 收到服务端"按权威状态重置"广播时强制重建编辑器（丢弃本地被污染的协同状态）
  const [remountToken, setRemountToken] = useState(0)

  const refreshTree = async () => {
    // SSE 抖动合并：300ms 内多次触发只拉取一次
    if (refreshTimer.current !== null) return
    refreshTimer.current = window.setTimeout(async () => {
      refreshTimer.current = null
      try {
        const { tree: t } = await api.tree()
        setTree(t)
      } catch {
        // 网络错误时静默，等下一次事件
      }
    }, 300)
  }

  useEffect(() => {
    void refreshTree()
    void api.themes().then(({ themes }) => setThemes(themes)).catch(() => {})

    // SSE：文件树变动（外部 git/vim 或其他端操作）→ 刷新侧栏
    const sse = new EventSource('/api/events')
    sse.addEventListener('tree', () => void refreshTree())
    let resetTimer = 0
    sse.addEventListener('doc-reset', (e) => {
      const { path } = JSON.parse((e as MessageEvent).data) as { path: string }
      const cur = useApp.getState().currentPath
      if (cur && (cur === path || cur.startsWith(path + '/'))) {
        // 防抖：连续重置广播只触发一次编辑器重建（防页面闪烁）
        window.clearTimeout(resetTimer)
        resetTimer = window.setTimeout(() => setRemountToken((n) => n + 1), 500)
      }
    })
    sse.addEventListener('doc-gone', (e) => {
      const { path } = JSON.parse((e as MessageEvent).data) as { path: string }
      const cur = useApp.getState().currentPath
      if (cur && (cur === path || cur.startsWith(path + '/'))) {
        setCurrentPath(null)
      }
    })
    sse.onerror = () => {
      /* EventSource 自动重连 */
    }
    return () => sse.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 树加载完成后：尚未选择文档时默认打开第一篇
  useEffect(() => {
    if (useApp.getState().currentPath) return
    const firstFile = (nodes: typeof tree): string | null => {
      for (const n of nodes) {
        if (n.type === 'file') return n.path
        if (n.children) {
          const found = firstFile(n.children)
          if (found) return found
        }
      }
      return null
    }
    const first = firstFile(tree)
    if (first) setCurrentPath(first)
  }, [tree, setCurrentPath])

  // 两阶段挂载 + 覆盖层：path 变化先渲染 loading 覆盖层（下一帧再挂载编辑器，
  // 保证大文档 PM 渲染阻塞主线程数秒期间覆盖层已在屏、进度条仍在动）；
  // 编辑器渲染就绪（PM mount 后的首个 rAF 回调）后淡出——小文档全程 <100ms 无感。
  const [editorMounted, setEditorMounted] = useState(false)
  const [overlayGone, setOverlayGone] = useState(false)
  useEffect(() => {
    setEditorMounted(false)
    setOverlayGone(false)
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEditorMounted(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [currentPath, remountToken])

  // 文档数据总量（进度百分比分母；失败则 0=不确定进度模式）
  const docProgress = useApp((s) => s.docProgress)
  useEffect(() => {
    if (!currentPath) return
    api
      .docSize(currentPath)
      .then(({ size }) => useApp.getState().setDocProgress({ total: size }))
      .catch(() => {})
  }, [currentPath])

  const onEditorReady = () => {
    // 再等两帧让首屏绘制完成，然后淡出覆盖层
    requestAnimationFrame(() => requestAnimationFrame(() => setOverlayGone(true)))
  }

  return (
    <div className="workspace">
      <Sidebar onTreeChanged={refreshTree} />
      <main className="main">
        <Topbar />
        <div className="editor-scroll">
          {currentPath ? (
            <div id="write" key={`${currentPath}#${remountToken}`}>
              {editorMounted && <MilkdownEditor path={currentPath} user={user!} onReady={onEditorReady} />}
              {!overlayGone && (
                <div className={`doc-loading ${editorMounted ? 'fade' : ''}`}>
                  <div className="doc-loading-bar">
                    {docProgress.total > 0 && docProgress.received > 0 && (
                      <div
                        className="doc-loading-fill"
                        style={{
                          width: `${Math.min(96, Math.round((docProgress.received / docProgress.total) * 100))}%`,
                        }}
                      />
                    )}
                  </div>
                  <div className="doc-loading-text">
                    {docProgress.total > 0 && docProgress.received > 0
                      ? `正在加载「${currentPath.split('/').pop()?.replace(/\.md$/i, '')}」… ${Math.min(
                          96,
                          Math.round((docProgress.received / docProgress.total) * 100),
                        )}%`
                      : `正在加载「${currentPath.split('/').pop()?.replace(/\.md$/i, '')}」…`}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">📝</div>
              <div>从左侧选择或新建一篇 Markdown 文档</div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
