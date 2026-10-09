/**
 * 编辑区（#write）独立缩放：不依赖浏览器整页缩放，
 * topbar / sidebar 尺寸恒定，只有正文随 --mf-zoom 缩放。
 * 快捷键（Typora 风格）：Cmd/Ctrl+Shift+= 放大、Cmd/Ctrl+Shift+- 缩小、Cmd/Ctrl+Shift+0 重置。
 * 范围 0.6–2.0，步长 0.1，localStorage 持久化。
 */
const KEY = 'mf-editor-zoom'
const MIN = 0.6
const MAX = 2.0

let zoom = 1

function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(v * 10) / 10))
}

function apply(): void {
  document.documentElement.style.setProperty('--mf-zoom', String(zoom))
}

export function getZoom(): number {
  return zoom
}

export function setZoom(v: number): number {
  zoom = clamp(v)
  try {
    localStorage.setItem(KEY, String(zoom))
  } catch { /* 隐私模式等场景静默降级 */ }
  apply()
  return zoom
}

export function initZoom(): void {
  const saved = parseFloat(localStorage.getItem(KEY) ?? '')
  zoom = Number.isFinite(saved) ? clamp(saved) : 1
  apply()

  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
    if (e.key === '=' || e.key === '+') {
      e.preventDefault()
      setZoom(zoom + 0.1)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      setZoom(zoom - 0.1)
    } else if (e.key === '0') {
      e.preventDefault()
      setZoom(1)
    }
  })
}
