import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import { useApp } from '../store'

const STATUS_TEXT: Record<string, string> = {
  connecting: '同步中…',
  synced: '已同步',
  error: '连接异常',
}

export function Topbar() {
  const currentPath = useApp((s) => s.currentPath)
  const docStatus = useApp((s) => s.docStatus)
  const themes = useApp((s) => s.themes)
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const onlineUsers = useApp((s) => s.onlineUsers)
  const user = useApp((s) => s.user)
  const setUser = useApp((s) => s.setUser)
  const setCurrentPath = useApp((s) => s.setCurrentPath)

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastSyncAt = useApp((s) => s.lastSyncAt)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('mf-sidebar-collapsed') === '1',
  )
  useEffect(() => {
    document.querySelector('.workspace')?.classList.toggle('collapsed', sidebarCollapsed)
  }, [sidebarCollapsed])

  const title = currentPath?.split('/').pop()?.replace(/\.md$/i, '') ?? 'MarkFlow'

  const logout = async () => {
    await api.logout().catch(() => {})
    setUser(null)
  }

  // 点击下拉外部关闭
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const imported: string[] = []
    for (const f of Array.from(files)) {
      try {
        const md = await f.text()
        const path = await importMarkdown(f.name, md)
        imported.push(path)
      } catch (e) {
        window.alert(`导入 ${f.name} 失败：${e instanceof Error ? e.message : '未知错误'}`)
      }
    }
    if (imported.length > 0) {
      // 文件树经 SSE 'tree' 广播自动刷新，这里直接打开最后一个导入的文档
      setCurrentPath(imported[imported.length - 1]!)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="sidebar-toggle"
          title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => {
            const next = !sidebarCollapsed
            setSidebarCollapsed(next)
            localStorage.setItem('mf-sidebar-collapsed', next ? '1' : '')
          }}
        >
          {sidebarCollapsed ? '»' : '«'}
        </button>
        <div className="topbar-title" title={currentPath ?? ''}>
          {title}
          <span
          className={`doc-status ${docStatus}`}
          title={`同步状态：${STATUS_TEXT[docStatus]}${
            lastSyncAt ? `\n上次同步：${new Date(lastSyncAt).toLocaleTimeString('zh-CN')}` : ''
          }\n在线协作：${onlineUsers.map((u) => u.name).join('、') || user}\n（版本回退功能规划中）`}
        >
            {STATUS_TEXT[docStatus]}
          </span>
        </div>
      </div>
      <div className="topbar-right">
        <div className="online-users" title={onlineUsers.map((u) => u.name).join('、')}>
          {onlineUsers.slice(0, 5).map((u) => (
            <span
              key={u.clientId}
              className="avatar"
              style={{ background: u.color }}
            >
              {u.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        <select
          className="theme-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          title="Typora 主题"
        >
          {themes.map((t) => (
            <option key={t.file} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="topbar-menu" ref={menuRef}>
          <button
            className="export-btn"
            disabled={!currentPath}
            onClick={() => setMenuOpen((v) => !v)}
            title="导出当前文档"
          >
            导出 ▾
          </button>
          {menuOpen && (
            <div className="dropdown-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void exportMarkdown()
                }}
              >
                Markdown（.md）
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void exportPdf()
                }}
              >
                PDF 文档
              </button>
            </div>
          )}
        </div>
        <button
          className="export-btn secondary"
          onClick={() => fileInputRef.current?.click()}
          title="导入 Markdown 文档为新的笔记"
        >
          导入
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,text/markdown"
          multiple
          hidden
          onChange={(e) => void onImportFiles(e.target.files)}
        />
        <span className="me" title={`当前用户：${user}`}>
          {user}
        </span>
        <button onClick={logout} title="退出登录">
          退出
        </button>
      </div>
    </header>
  )
}

/** 导入 markdown：重名自动追加序号（笔记-1.md、笔记-2.md …） */
async function importMarkdown(fileName: string, md: string): Promise<string> {
  const base = fileName.replace(/\.(md|markdown)$/i, '')
  const ext = /\.(md|markdown)$/i.test(fileName) ? '' : '.md'
  for (let i = 0; i < 50; i++) {
    const name = i === 0 ? `${base}${ext}` : `${base}-${i}${ext || '.md'}`
    try {
      const { path } = await api.createFile('', name, md)
      return path
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) continue // 重名 → 换下一个序号
      throw e
    }
  }
  throw new Error('重名文件过多')
}

async function exportMarkdown() {
  const path = useApp.getState().currentPath
  if (!path) return
  const res = await fetch(`/api/export/md?path=${encodeURIComponent(path)}`, {
    credentials: 'same-origin',
  })
  if (!res.ok) {
    window.alert('导出失败')
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${path.split('/').pop()?.replace(/\.md$/i, '')}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function exportPdf() {
  const path = useApp.getState().currentPath
  if (!path) return
  const theme = useApp.getState().theme
  try {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ path, theme }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `导出失败（${res.status}）`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${path.split('/').pop()?.replace(/\.md$/i, '')}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    window.alert(e instanceof Error ? e.message : '导出失败')
  }
}
