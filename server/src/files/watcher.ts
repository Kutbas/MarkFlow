import path from 'node:path'
import chokidar from 'chokidar'
import { config } from '../config.js'
import { sseHub } from '../events.js'
import { isMarkdownPath } from './paths.js'

export interface NoteEvent {
  /** POSIX 相对路径 */
  relPath: string
  kind: 'add' | 'change' | 'unlink'
}

type NoteListener = (event: NoteEvent) => void
const noteListeners = new Set<NoteListener>()

/** M2 的外部改动同步模块通过此接口订阅 .md 内容事件 */
export function onNoteEvent(listener: NoteListener): () => void {
  noteListeners.add(listener)
  return () => noteListeners.delete(listener)
}

/**
 * 磁盘文件监听：捕获外部程序（git/vim 等）对笔记目录的改动。
 * - 文件树结构变化 → SSE 广播 'tree'（前端刷新侧栏）
 * - .md 内容变化 → NoteEvent（M2 协同模块做文档重置/缓存失效）
 * 忽略点开头条目（.git、.DS_Store 等）与临时落盘文件（.tmp-*）。
 */
export function startNoteWatcher() {
  const root = config.notesDir
  const watcher = chokidar.watch(root, {
    ignored: (p) => {
      const base = path.basename(p)
      if (base === path.basename(root)) return false
      return base.startsWith('.') || base.startsWith('.tmp-markflow-')
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 80 },
  })

  const relOf = (abs: string) => path.relative(root, abs).split(path.sep).join('/')

  watcher
    .on('add', (abs) => {
      const rel = relOf(abs)
      sseHub.broadcast('tree', { reason: 'add', path: rel })
      if (isMarkdownPath(rel)) emit({ relPath: rel, kind: 'add' })
    })
    .on('addDir', (abs) => {
      if (abs === root) return
      sseHub.broadcast('tree', { reason: 'addDir', path: relOf(abs) })
    })
    .on('unlink', (abs) => {
      const rel = relOf(abs)
      sseHub.broadcast('tree', { reason: 'unlink', path: rel })
      if (isMarkdownPath(rel)) emit({ relPath: rel, kind: 'unlink' })
    })
    .on('unlinkDir', (abs) => {
      if (abs === root) return
      sseHub.broadcast('tree', { reason: 'unlinkDir', path: relOf(abs) })
      // 目录删除：其下所有文档一律按删除处理
      const prefix = relOf(abs)
      emit({ relPath: prefix, kind: 'unlink' })
    })
    .on('change', (abs) => {
      const rel = relOf(abs)
      if (isMarkdownPath(rel)) emit({ relPath: rel, kind: 'change' })
      else sseHub.broadcast('tree', { reason: 'change', path: rel })
    })
    .on('error', (err) => console.error('[MarkFlow] 文件监听错误:', err))

  function emit(event: NoteEvent) {
    for (const listener of noteListeners) listener(event)
  }

  console.log(`[MarkFlow] 文件监听已启动: ${root}`)
  return watcher
}
