import { useEffect, useRef } from 'react'
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

  return (
    <div className="workspace">
      <Sidebar onTreeChanged={refreshTree} />
      <main className="main">
        <Topbar />
        <div className="editor-scroll">
          {currentPath ? (
            <div id="write" key={currentPath}>
              <MilkdownEditor path={currentPath} user={user!} />
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
