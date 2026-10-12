import { useState } from 'react'
import type { TreeNode } from '../api/client'
import { api, ApiError } from '../api/client'
import { useApp } from '../store'

async function promptName(title: string, initial = ''): Promise<string | null> {
  const name = window.prompt(title, initial)
  return name === null ? null : name.trim()
}

/** 路径迁移后重写当前打开的文档路径（自身或其子孙路径整体跟随） */
export function followMovedPath(
  currentPath: string | null | undefined,
  from: string,
  to: string,
): string | null {
  if (!currentPath) return null
  if (currentPath === from) return to
  if (currentPath.startsWith(from + '/')) return to + currentPath.slice(from.length)
  return currentPath
}

/** 父目录（根目录返回 ''） */
function parentDirOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '' : p.slice(0, idx)
}

function NodeMenu({
  node,
  onTreeChanged,
}: {
  node: TreeNode
  onTreeChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const currentPath = useApp((s) => s.currentPath)
  const setCurrentPath = useApp((s) => s.setCurrentPath)
  const err = (e: unknown) => {
    window.alert(e instanceof ApiError ? e.message : '操作失败')
  }

  const doRename = async () => {
    setOpen(false)
    const newName = await promptName('重命名', node.name)
    if (!newName || newName === node.name) return
    try {
      const { path: newPath } = await api.rename(node.path, newName)
      // 打开中的文档（或被改名文件夹的子孙）跟随新路径，不中断编辑
      const followed = followMovedPath(currentPath, node.path, newPath)
      if (followed !== currentPath) setCurrentPath(followed)
      onTreeChanged()
    } catch (e) {
      err(e)
    }
  }

  const doMove = async () => {
    setOpen(false)
    const dir = await promptName('移动到（留空 = 根目录）', '')
    if (dir === null) return
    try {
      const { path: newPath } = await api.move(node.path, dir.trim())
      const followed = followMovedPath(currentPath, node.path, newPath)
      if (followed !== currentPath) setCurrentPath(followed)
      onTreeChanged()
    } catch (e) {
      err(e)
    }
  }

  const doDelete = async () => {
    setOpen(false)
    const label = node.type === 'dir' ? '文件夹及其全部内容' : '文档'
    if (!window.confirm(`确定删除${label}「${node.name}」？此操作不可恢复。`)) return
    try {
      await api.remove(node.path)
      if (currentPath === node.path || currentPath?.startsWith(node.path + '/')) {
        setCurrentPath(null)
      }
      onTreeChanged()
    } catch (e) {
      err(e)
    }
  }

  return (
    <span className="node-menu-wrap">
      <button
        className="node-menu-btn"
        title="更多操作"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        ⋯
      </button>
      {open && (
        <>
          <span className="menu-backdrop" onClick={() => setOpen(false)} />
          <span className="node-menu">
            <button onClick={doRename}>✏️ 重命名</button>
            <button onClick={doMove}>📁 移动到…</button>
            <button className="danger" onClick={doDelete}>
              🗑 删除
            </button>
          </span>
        </>
      )}
    </span>
  )
}

function TreeItem({
  node,
  depth,
  onTreeChanged,
  selectedDir,
  setSelectedDir,
}: {
  node: TreeNode
  depth: number
  onTreeChanged: () => void
  selectedDir: string | null
  setSelectedDir: (dir: string | null) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropOn, setDropOn] = useState(false)
  const currentPath = useApp((s) => s.currentPath)
  const setCurrentPath = useApp((s) => s.setCurrentPath)
  const active = currentPath === node.path
  const dirSelected = node.type === 'dir' && selectedDir === node.path

  /** 拖拽放置合法性：非自身、非自身子孙、目标父目录不是当前所在目录 */
  const canDrop = (dragPath: string): boolean => {
    if (dragPath === node.path) return false
    if (node.type !== 'dir') return false
    if (dragPath.startsWith(node.path + '/')) return false
    if (node.path === '') return parentDirOf(dragPath) !== ''
    return parentDirOf(dragPath) !== node.path
  }

  const onDragOver = (e: React.DragEvent) => {
    // dragover 阶段部分浏览器读不到 data（受保护），只按目录身份放行，
    // 真正的合法性判定放 drop 时做（服务端还有兜底）
    e.stopPropagation()
    if (node.type !== 'dir') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropOn(true)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setDropOn(false)
    const dragPath = e.dataTransfer.getData('text/plain')
    if (!dragPath || !canDrop(dragPath)) return
    try {
      const { path: newPath } = await api.move(dragPath, node.path)
      const followed = followMovedPath(useApp.getState().currentPath, dragPath, newPath)
      if (followed !== useApp.getState().currentPath) setCurrentPath(followed)
      setExpanded(true)
      onTreeChanged()
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : '移动失败')
    }
  }

  return (
    <div>
      <div
        className={`tree-item ${active ? 'active' : ''} ${dirSelected ? 'dir-selected' : ''} ${dropOn ? 'drop-target' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', node.path)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropOn(false)}
        onDrop={onDrop}
        onClick={() => {
          if (node.type === 'file') {
            setSelectedDir(null)
            setCurrentPath(node.path)
          } else {
            setSelectedDir(node.path)
            setExpanded((v) => !v)
          }
        }}
      >
        <span
          className={`tree-caret ${node.type === 'dir' ? '' : 'leaf'}`}
          onClick={(e) => {
            if (node.type !== 'dir') return
            e.stopPropagation()
            setSelectedDir(node.path)
            setExpanded((v) => !v)
          }}
          title={node.type === 'dir' ? (expanded ? '折叠目录' : '展开目录') : undefined}
        >
          {node.type === 'dir' ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="tree-icon">
          {node.type === 'dir' ? (expanded ? '📂' : '📁') : '📄'}
        </span>
        <span className="tree-name" title={node.path}>
          {node.name}
        </span>
        <NodeMenu node={node} onTreeChanged={onTreeChanged} />
      </div>
      {node.type === 'dir' &&
        expanded &&
        node.children?.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            onTreeChanged={onTreeChanged}
            selectedDir={selectedDir}
            setSelectedDir={setSelectedDir}
          />
        ))}
    </div>
  )
}

export function FileTree({ onTreeChanged }: { onTreeChanged: () => void }) {
  const tree = useApp((s) => s.tree)
  const setCurrentPath = useApp((s) => s.setCurrentPath)
  // 选中的目录（null=未选）：新建文档/文件夹落在这里；点文件即清除
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const selectedDirName =
    selectedDir === null ? '' : selectedDir.slice(selectedDir.lastIndexOf('/') + 1)

  const createFile = async () => {
    const where = selectedDir === null ? '根目录' : `「${selectedDirName}」`
    const name = await promptName(`新文档名（将创建于${where}，自动补 .md）`)
    if (!name) return
    try {
      const { path } = await api.createFile(selectedDir ?? '', name)
      onTreeChanged()
      setCurrentPath(path)
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : '创建失败')
    }
  }

  const createFolder = async () => {
    const where = selectedDir === null ? '根目录' : `「${selectedDirName}」内`
    const name = await promptName(`新文件夹名（将创建于${where}）`)
    if (!name) return
    try {
      await api.createFolder(selectedDir ?? '', name)
      onTreeChanged()
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : '创建失败')
    }
  }

  return (
    <div className="file-tree">
      <div className="tree-toolbar">
        <span className="tree-title">文档</span>
        <span>
          <button title="新建文档" onClick={createFile}>
            ＋📄
          </button>
          <button title="新建文件夹" onClick={createFolder}>
            ＋📁
          </button>
        </span>
      </div>
      <div
        className="tree-body"
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        onDrop={async (e) => {
          // 行级 onDrop 已 stopPropagation；到达这里 = 拖到空白区 = 移到根目录
          e.preventDefault()
          const dragPath = e.dataTransfer.getData('text/plain')
          if (!dragPath || parentDirOf(dragPath) === '') return
          try {
            await api.move(dragPath, '')
            onTreeChanged()
          } catch (err) {
            window.alert(err instanceof ApiError ? err.message : '移动失败')
          }
        }}
      >
        {tree.length === 0 && <div className="tree-empty">（空）</div>}
        {tree.map((n) => (
          <TreeItem
            key={n.path}
            node={n}
            depth={0}
            onTreeChanged={onTreeChanged}
            selectedDir={selectedDir}
            setSelectedDir={setSelectedDir}
          />
        ))}
      </div>
    </div>
  )
}
