import { useApp } from '../store'

/** 文档大纲：点击跳转到对应标题（按标题文本匹配 DOM） */
export function Outline() {
  const outline = useApp((s) => s.outline)
  const currentPath = useApp((s) => s.currentPath)

  const jump = (text: string) => {
    const write = document.getElementById('write')
    if (!write) return
    for (const h of write.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      if (h.textContent?.trim() === text) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' })
        h.animate?.([{ background: 'rgba(80,123,108,.25)' }, { background: 'none' }], {
          duration: 1200,
        })
        return
      }
    }
  }

  if (!currentPath) return <div className="outline-empty">未打开文档</div>
  if (outline.length === 0)
    return <div className="outline-empty">文档暂无标题</div>

  return (
    <div className="outline-list">
      {outline.map((item, i) => (
        <div
          key={i}
          className="outline-item"
          style={{ paddingLeft: (item.level - 1) * 12 + 10 }}
          onClick={() => jump(item.text)}
          title={item.text}
        >
          <span className="outline-h">H{item.level}</span>
          <span className="outline-text">{item.text}</span>
        </div>
      ))}
    </div>
  )
}
