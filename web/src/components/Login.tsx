import { useState } from 'react'
import { api, ApiError } from '../api/client'

export function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.login(name.trim(), password)
      onLogin(user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">MarkFlow</div>
        <div className="login-sub">实时协同 · Typora 风格所见即所得 · 数据库存储 · 随时导出 Markdown</div>
        <input
          autoFocus
          placeholder="用户名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !name || !password}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
