import { useEffect, useState } from 'react'
import { api } from './api/client'
import { useApp } from './store'
import { Login } from './components/Login'
import { Workspace } from './components/Workspace'

export function App() {
  const user = useApp((s) => s.user)
  const setUser = useApp((s) => s.setUser)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api
      .me()
      .then(({ user: u }) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setChecking(false))

    // API 401：会话中过期 → 保住编辑现场（登录弹窗 + 断线横幅红色态），
    // 仅冷启动未登录才整页回登录页
    const onUnauthorized = () => {
      if (useApp.getState().user) useApp.getState().setAuthFailed(true)
      else setUser(null)
    }
    window.addEventListener('mf:unauthorized', onUnauthorized)
    return () => window.removeEventListener('mf:unauthorized', onUnauthorized)
  }, [setUser])

  if (checking) return <div className="boot-screen">MarkFlow 加载中…</div>
  if (!user) return <Login onLogin={setUser} />
  return <Workspace />
}
