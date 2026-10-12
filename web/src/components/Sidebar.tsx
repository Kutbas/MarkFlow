import { useEffect, useMemo, useState } from 'react'
import { FileTree } from './FileTree'
import { Outline } from './Outline'
import { useApp } from '../store'
import { searchOutline, searchTree, stepMatch } from './sidebar-search'

/**
 * 侧栏：文档树 / 大纲 + 悬停浮现的搜索框（Chrome 式 n/总数 + 上下筛选）。
 * 文档模式：命中 = 打开文档（编辑区跟随）+ 树中展开并高亮定位；
 * 大纲模式：命中 = 编辑区滚动到标题 + 大纲高亮定位。
 */
export function Sidebar({ onTreeChanged }: { onTreeChanged: () => void }) {
  const [tab, setTab] = useState<'files' | 'outline'>('files')
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)

  const tree = useApp((s) => s.tree)
  const outline = useApp((s) => s.outline)
  const setCurrentPath = useApp((s) => s.setCurrentPath)

  const fileMatches = useMemo(() => searchTree(tree, query), [tree, query])
  const outlineMatches = useMemo(() => searchOutline(outline, query), [outline, query])
  const total = tab === 'files' ? fileMatches.length : outlineMatches.length
  // 结果集变化时（新查询/切换页签/数据刷新）钳制回有效范围
  useEffect(() => {
    setMatchIdx((i) => (total === 0 ? 0 : Math.min(i, total - 1)))
  }, [total])

  const idx = Math.min(matchIdx, Math.max(total - 1, 0))
  const currentFile = tab === 'files' && fileMatches.length > 0 ? fileMatches[idx] : null
  const currentOutline = tab === 'outline' && outlineMatches.length > 0 ? outlineMatches[idx] : null
  // 传给 FileTree 的定位路径（文档模式：文件或文件夹都定位展开；null 不定位）
  const revealPath = currentFile ? currentFile.path : null
  // 传给 Outline 的定位标题序号（大纲模式；-1 不定位）
  const outlineMatchIndex = currentOutline ? currentOutline.index : -1

  // 命中变化即应用：文档模式打开文档；大纲模式由 Outline 内部滚动跳转
  useEffect(() => {
    if (currentFile && currentFile.type === 'file') setCurrentPath(currentFile.path)
  }, [currentFile, setCurrentPath])

  const go = (dir: 1 | -1) => {
    if (total === 0) return
    setMatchIdx(stepMatch(matchIdx, dir, total))
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={tab === 'files' ? 'on' : ''}
          onClick={() => {
            setTab('files')
            setMatchIdx(0)
          }}
        >
          文档
        </button>
        <button
          className={tab === 'outline' ? 'on' : ''}
          onClick={() => {
            setTab('outline')
            setMatchIdx(0)
          }}
        >
          大纲
        </button>
      </div>

      {/* 搜索行：常驻占位（不与下方工具栏重叠），侧栏悬停时淡入浮现 */}
      <div className={`sidebar-search ${total > 0 ? 'has-hits' : ''}`}>
        <input
          type="text"
          placeholder={tab === 'files' ? '搜索文档…' : '搜索标题…'}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value)
            setMatchIdx(0)
          }}
          onKeyDown={(e) => {
            e.stopPropagation() // 不让按键漏进编辑器快捷键
            if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
            if (e.key === 'Escape') {
              setQuery('')
              if (e.target instanceof HTMLInputElement) e.target.blur()
            }
          }}
        />
        {query.trim() !== '' && (
          <span className="search-count" title="当前/全部匹配">
            {total > 0 ? idx + 1 : 0}/{total}
          </span>
        )}
        <button
          className="search-nav"
          title="上一个 (Shift+Enter)"
          disabled={total === 0}
          onClick={() => go(-1)}
        >
          ↑
        </button>
        <button
          className="search-nav"
          title="下一个 (Enter)"
          disabled={total === 0}
          onClick={() => go(1)}
        >
          ↓
        </button>
      </div>

      {tab === 'files' ? (
        <FileTree onTreeChanged={onTreeChanged} revealPath={revealPath} />
      ) : (
        <Outline activeMatchIndex={outlineMatchIndex} />
      )}
    </aside>
  )
}
