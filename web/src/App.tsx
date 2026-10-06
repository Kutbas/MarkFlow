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

    const onUnauthorized = () => setUser(null)
    window.addEventListener('mf:unauthorized', onUnauthorized)
    return () => window.removeEventListener('mf:unauthorized', onUnauthorized)
  }, [setUser])

  if (checking) return <div className="boot-screen">MarkFlow 加载中…</div>
  if (!user) return <Login onLogin={setUser} />
  return <Workspace />
}
