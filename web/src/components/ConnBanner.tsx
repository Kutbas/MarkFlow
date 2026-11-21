/**
 * 连接状态横幅（编辑器顶部）：
 * - 会话过期（WS 认证被拒 / API 401）：红色——LoginModal 同时自动弹出
 * - 网络断开（曾连上后断线，自动重连中）：琥珀色，连上自动消失
 * 首次连接不显示（doc-loading 覆盖层已覆盖该阶段）
 */
import { useApp } from '../store'

export function ConnBanner() {
  const docStatus = useApp((s) => s.docStatus)
  const authFailed = useApp((s) => s.authFailed)

  if (authFailed) {
    return (
      <div className="conn-banner conn-error" role="alert">
        <span className="conn-text">登录已过期，编辑内容已本地保存</span>
        <span className="conn-hint">重新登录后自动恢复同步</span>
      </div>
    )
  }
  if (docStatus === 'disconnected') {
    return (
      <div className="conn-banner conn-warn" role="status">
        <span className="conn-text">连接已断开，正在自动重连…</span>
        <span className="conn-hint">编辑内容已本地保存，恢复连接后自动同步</span>
      </div>
    )
  }
  return null
}
