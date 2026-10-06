import { useState } from 'react'
import type { TreeNode } from '../api/client'
import { api, ApiError } from '../api/client'
import { useApp } from '../store'

async function promptName(title: string, initial = ''): Promise<string | null> {
  const name = window.prompt(title, initial)
  return name === null ? null : name.trim()
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
      await api.rename(node.path, newName)
      if (currentPath === node.path) setCurrentPath(null)
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
      await api.move(node.path, dir.trim())
      if (currentPath === node.path) setCurrentPath(null)
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
}: {
  node: TreeNode
  depth: number
  onTreeChanged: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const currentPath = useApp((s) => s.currentPath)
  const setCurrentPath = useApp((s) => s.setCurrentPath)
  const active = currentPath === node.path

  return (
    <div>
      <div
        className={`tree-item ${active ? 'active' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => {
          if (node.type === 'file') setCurrentPath(node.path)
          else setExpanded((v) => !v)
        }}
      >
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
          />
        ))}
    </div>
  )
}

export function FileTree({ onTreeChanged }: { onTreeChanged: () => void }) {
  const tree = useApp((s) => s.tree)
  const setCurrentPath = useApp((s) => s.setCurrentPath)

  const createFile = async () => {
    const name = await promptName('新文档名（自动补 .md）')
    if (!name) return
    try {
      const { path } = await api.createFile('', name)
      onTreeChanged()
      setCurrentPath(path)
    } catch (e) {
      window.alert(e instanceof ApiError ? e.message : '创建失败')
    }
  }

  const createFolder = async () => {
    const name = await promptName('新文件夹名')
    if (!name) return
    try {
      await api.createFolder('', name)
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
      <div className="tree-body">
        {tree.length === 0 && <div className="tree-empty">（空）</div>}
        {tree.map((n) => (
          <TreeItem key={n.path} node={n} depth={0} onTreeChanged={onTreeChanged} />
        ))}
      </div>
    </div>
  )
}
