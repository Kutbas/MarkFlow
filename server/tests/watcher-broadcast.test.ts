/** watcher 非 md change → SSE tree 广播（独立文件避免与其他 watcher 用例互相干扰） */
import './helpers/env.js'
import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startNoteWatcher } from '../src/files/watcher.js'
import { sseHub } from '../src/events.js'

const NOTES = process.env.NOTES_DIR!

it('txt 变更广播 tree 事件（不产生 NoteEvent）', async () => {
  const { onNoteEvent } = await import('../src/files/watcher.js')
  const seen: string[] = []
  const off = onNoteEvent((e) => seen.push(e.relPath))
  const spy = vi.spyOn(sseHub, 'broadcast').mockImplementation(() => {})
  const watcher = startNoteWatcher()
  await new Promise((r) => setTimeout(r, 400))
  const txt = path.join(NOTES, '广播.txt')
  fs.writeFileSync(txt, 'x')
  await new Promise((r) => setTimeout(r, 1500))
  await watcher.close()
  fs.rmSync(txt, { force: true })
  off()
  expect(spy).toHaveBeenCalledWith('tree', expect.objectContaining({ path: '广播.txt' }))
  expect(seen).toEqual([])
  spy.mockRestore()
}, 12000)
