/**
 * 文档本地缓存（y-indexeddb）：编辑内容实时落浏览器 IndexedDB——断线/
 * 刷新/过期都不丢，重连后 CRDT 自动合并同步。
 * 每文档一个库（markflow-doc:<path>）；doc-reset/doc-gone 时必须清掉
 * 本地缓存，否则 CRDT 会把旧内容复活进服务端重置后的权威文档。
 */
import { IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'

const active = new Map<string, IndexeddbPersistence>()

const dbName = (path: string): string => `markflow-doc:${path}`

/** 挂载本地持久化（编辑器组件创建 ydoc 后调用；IDB 不可用如隐私模式静默降级） */
export function attachLocalDoc(path: string, ydoc: Y.Doc): void {
  if (active.has(path)) return
  try {
    active.set(path, new IndexeddbPersistence(dbName(path), ydoc))
  } catch {
    // IndexedDB 不可用：纯在线模式，功能不受影响
  }
}

/** 卸载持久化实例（IndexedDB 数据保留） */
export function detachLocalDoc(path: string): void {
  const p = active.get(path)
  if (p) {
    p.destroy()
    active.delete(path)
  }
}

/** 清除某文档的本地缓存（服务端权威重置/删除时调用） */
export async function clearLocalDoc(path: string): Promise<void> {
  const p = active.get(path)
  if (p) {
    await p.clearData()
    return
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName(path))
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}
