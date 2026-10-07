import { api } from '../api/client'
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

  const title = currentPath?.split('/').pop()?.replace(/\.md$/i, '') ?? 'MarkFlow'

  const logout = async () => {
    await api.logout().catch(() => {})
    setUser(null)
  }

  return (
    <header className="topbar">
      <div className="topbar-title" title={currentPath ?? ''}>
        {title}
        <span className={`doc-status ${docStatus}`}>{STATUS_TEXT[docStatus]}</span>
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
        <button
          className="export-btn secondary"
          disabled={!currentPath}
          onClick={() => void exportMarkdown()}
          title="下载当前文档的 Markdown 源文件"
        >
          导出 MD
        </button>
        <button className="export-btn" disabled={!currentPath} onClick={() => void exportPdf()}>
          导出 PDF
        </button>
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
  try {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ path }),
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
