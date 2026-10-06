import { useState } from 'react'
import { FileTree } from './FileTree'
import { Outline } from './Outline'

export function Sidebar({ onTreeChanged }: { onTreeChanged: () => void }) {
  const [tab, setTab] = useState<'files' | 'outline'>('files')

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={tab === 'files' ? 'on' : ''}
          onClick={() => setTab('files')}
        >
          文档
        </button>
        <button
          className={tab === 'outline' ? 'on' : ''}
          onClick={() => setTab('outline')}
        >
          大纲
        </button>
      </div>
      {tab === 'files' ? (
        <FileTree onTreeChanged={onTreeChanged} />
      ) : (
        <Outline />
      )}
    </aside>
  )
}
