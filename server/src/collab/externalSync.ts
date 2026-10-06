import fs from 'node:fs'
import * as Y from 'yjs'
import { mdToUpdate } from '../interop/index.js'
import { sseHub } from '../events.js'
import { onNoteEvent, type NoteEvent } from '../files/watcher.js'
import { sha1 } from '../util/atomicWrite.js'
import { hocuspocus } from './hocuspocus.js'
import {
  ensureState,
  forgetState,
  getLastKnownHash,
  relToAbs,
  relToDocName,
  setLastKnownHash,
} from './docRegistry.js'

/**
 * 外部改动同步：Chokidar 捕获到 git/vim 等外部程序对 .md 的修改后，
 * - 在线文档：以磁盘最新内容单事务重置协同树（所有在线页面立即收到新内容）
 * - 离线文档：无需处理（下次打开时 onLoadDocument 从磁盘读取）
 * 自身防抖落盘触发的 change 事件通过内容哈希比对抑制（回声消除）。
 */
export function startExternalSync(): void {
  onNoteEvent((event: NoteEvent) => {
    void dispatchNoteEvent(event)
  })
}

/** 单个事件的分发（含异常兜底）：独立导出便于测试 */
export async function dispatchNoteEvent(event: NoteEvent): Promise<void> {
  try {
    await handleNoteEvent(event)
  } catch (err) {
    console.error('[MarkFlow] 外部同步失败:', event, err)
  }
}

async function handleNoteEvent(event: NoteEvent): Promise<void> {
  const { relPath, kind } = event

  if (kind === 'unlink') {
    handleUnlink(relPath)
    return
  }

  // add / change
  const docName = relToDocName(relPath)
  const doc = hocuspocus.documents.get(docName)
  if (!doc) return // 离线：无需处理
  ensureState(relPath)

  const abs = relToAbs(relPath)
  if (!fs.existsSync(abs)) return
  const md = fs.readFileSync(abs, 'utf8')
  const hash = sha1(md)
  if (hash === getLastKnownHash(relPath)) return // 自身落盘的回声

  console.log(`[MarkFlow] 外部改动已捕获，重置在线文档: ${relPath}`)
  const update = await mdToUpdate(md)
  doc.transact(() => {
    const fragment = doc.getXmlFragment('prosemirror')
    fragment.delete(0, fragment.length)
    Y.applyUpdate(doc, update, 'markflow-external')
  })
  setLastKnownHash(relPath, hash)
  sseHub.broadcast('doc-reset', { path: relPath })
}

/** 文件或目录被删除：下线所有受影响文档（含目录前缀匹配） */
function handleUnlink(relPath: string): void {
  for (const docName of [...hocuspocus.documents.keys()]) {
    const doc = hocuspocus.documents.get(docName)
    if (!doc) continue
    const rel = decodeURIComponent(docName)
    if (rel !== relPath && !rel.startsWith(relPath + '/')) continue
    hocuspocus.closeConnections(docName)
    void hocuspocus.unloadDocument(doc).catch(() => {})
    forgetState(rel)
    sseHub.broadcast('doc-gone', { path: rel })
  }
}
