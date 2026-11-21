import { useState } from 'react'
import { api, ApiError } from '../api/client'

/** 登录表单（整页登录与会话过期弹窗共用） */
export function LoginForm({ onLogin }: { onLogin: (user: string) => void }) {
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
    <form onSubmit={submit}>
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
  )
}

export function Login({ onLogin }: { onLogin: (user: string) => void }) {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">MarkFlow</div>
        <div className="login-sub">实时协同 · Typora 风格所见即所得 · 数据库存储 · 随时导出 Markdown</div>
        <LoginForm onLogin={onLogin} />
      </div>
    </div>
  )
}

/** 会话过期重登弹窗：覆盖在工作区上（保住编辑现场），成功后恢复协同连接 */
export function LoginModal({ onRelogin }: { onRelogin: (user: string) => void }) {
  return (
    <div className="login-modal-mask">
      <div className="login-modal">
        <div className="login-modal-title">登录已过期</div>
        <div className="login-modal-sub">你的编辑内容已本地保存，重新登录后自动恢复同步</div>
        <LoginForm onLogin={onRelogin} />
      </div>
    </div>
  )
}
