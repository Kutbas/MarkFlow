/**
 * 延迟播种机制：服务端重启后不得用全新 Yjs ID 覆盖重连客户端带回的内容
 * （否则两套不同 ID 的同份内容合并后会成倍复制——已在线上实际发生过）。
 */
import './helpers/env.js'

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { collabHooks, hocuspocus, shutdownCollab } from '../src/collab/hocuspocus.js'
import { ensureState } from '../src/collab/docRegistry.js'
import { mdToUpdate, yDocToMd } from '../src/interop/index.js'

const NOTES = process.env.NOTES_DIR!
const GRACE = 150

function headingCount(md: string): number {
  return (md.match(/^# /gm) ?? []).length
}

async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

describe('延迟播种（seed grace）', () => {
  it('空文档 + 无客户端内容 → 窗口期后播种一次', async () => {
    fs.writeFileSync(path.join(NOTES, '播种a.md'), '# 播种A\n\n内容\n')
    ensureState('播种a.md')
    const doc = new Y.Doc()
    // 钩子立即返回（连接不被阻塞）
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种a.md' } as never)
    expect(doc.getXmlFragment('prosemirror').length).toBe(0)
    await wait(GRACE + 400)
    const md = await yDocToMd(doc)
    expect(md).toContain('# 播种A')
    expect(headingCount(md)).toBe(1)
  }, 10_000)

  it('重连客户端在窗口期内带回内容 → 不再播种（零复制）', async () => {
    fs.writeFileSync(path.join(NOTES, '播种b.md'), '# 播种B\n\n内容\n')
    ensureState('播种b.md')
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种b.md' } as never)
    // 模拟重连客户端：立即推入自己持有的（旧 ID）同份内容
    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, await mdToUpdate('# 播种B\n\n内容\n'))
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(clientDoc))
    await wait(GRACE + 400)
    const md = await yDocToMd(doc)
    expect(headingCount(md)).toBe(1) // 关键断言：无翻倍
  }, 10_000)

  it('同一文档重复触发 onLoadDocument 只调度一次播种', async () => {
    fs.writeFileSync(path.join(NOTES, '播种c.md'), '# 播种C\n')
    ensureState('播种c.md')
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种c.md' } as never)
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种c.md' } as never)
    await wait(GRACE + 400)
    expect(headingCount(await yDocToMd(doc))).toBe(1)
  }, 10_000)

  it('已有内容的文档直接返回，不进入播种流程', async () => {
    fs.writeFileSync(path.join(NOTES, '播种d.md'), '# 磁盘D\n')
    ensureState('播种d.md')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# 客户端已有D\n'))
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种d.md' } as never)
    // 同步返回且内容保持客户端版本
    expect(doc.getXmlFragment('prosemirror').toString()).toContain('客户端已有D')
    await wait(GRACE + 300)
    expect(await yDocToMd(doc)).toContain('客户端已有D')
    expect(await yDocToMd(doc)).not.toContain('磁盘D')
  }, 10_000)

  it('shutdownCollab 冲刷挂起落盘', async () => {
    const spy = vi.spyOn(hocuspocus, 'flushPendingStores').mockImplementation(() => {})
    await shutdownCollab()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('异常协同状态守卫', () => {
  it('空图片节点：拒绝落库、断开文档并广播重置（磁盘不被污染）', async () => {
    fs.writeFileSync(path.join(NOTES, '守卫a.md'), '# 守卫A\n\n正文一段\n')
    ensureState('守卫a.md')
    const dirty = new Y.Doc()
    Y.applyUpdate(dirty, await mdToUpdate('# 守卫A\n\n正文一段\n\n![](x)\n'))
    const { hocuspocus } = await import('../src/collab/hocuspocus.js')
    const { sseHub } = await import('../src/events.js')
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const bcastSpy = vi.spyOn(sseHub, 'broadcast').mockImplementation(() => {})
    try {
      const before = fs.readFileSync(path.join(NOTES, '守卫a.md'), 'utf8')
      await collabHooks.onStoreDocument!({ document: dirty, documentName: '守卫a.md' } as never)
      expect(fs.readFileSync(path.join(NOTES, '守卫a.md'), 'utf8')).toBe(before) // 磁盘未被污染
      expect(closeSpy).toHaveBeenCalledWith('守卫a.md')
      expect(bcastSpy).toHaveBeenCalledWith('doc-reset', { path: '守卫a.md' })
    } finally {
      closeSpy.mockRestore()
      bcastSpy.mockRestore()
    }
  }, 10_000)

  it('整倍内容（用户全选复制）属合法编辑：正常落盘不误伤', async () => {
    const single = '# 守卫B\n\n段落一\n\n段落二\n\n段落三\n'
    fs.writeFileSync(path.join(NOTES, '守卫b.md'), single)
    ensureState('守卫b.md')
    const doubled = new Y.Doc()
    const triple = single + '\n' + single + '\n' + single
    Y.applyUpdate(doubled, await mdToUpdate(triple))
    await collabHooks.onStoreDocument!({ document: doubled, documentName: '守卫b.md' } as never)
    expect(fs.readFileSync(path.join(NOTES, '守卫b.md'), 'utf8')).toContain('段落三') // 已写入
  }, 10_000)

  it('正常编辑不触发守卫', async () => {
    fs.writeFileSync(path.join(NOTES, '守卫c.md'), '# 守卫C\n\n原文\n')
    ensureState('守卫c.md')
    const normal = new Y.Doc()
    Y.applyUpdate(normal, await mdToUpdate('# 守卫C\n\n用户正常编辑的新段落，加长内容确保长度检查通过。\n'))
    await collabHooks.onStoreDocument!({ document: normal, documentName: '守卫c.md' } as never)
    expect(fs.readFileSync(path.join(NOTES, '守卫c.md'), 'utf8')).toContain('用户正常编辑')
  }, 10_000)
})

describe('异常状态守卫冷却', () => {
  it('冷却期内第二次异常静默跳过（不重复广播）', async () => {
    fs.writeFileSync(path.join(NOTES, '冷却.md'), '# 冷却\n\n段落一\n\n段落二\n')
    ensureState('冷却.md')
    const dirty = new Y.Doc()
    Y.applyUpdate(dirty, await mdToUpdate('# 冷却\n\n段落一\n\n段落二\n\n![](x)\n'))
    const { hocuspocus } = await import('../src/collab/hocuspocus.js')
    const { sseHub } = await import('../src/events.js')
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const spy = vi.spyOn(sseHub, 'broadcast').mockImplementation(() => {})
    try {
      await collabHooks.onStoreDocument!({ document: dirty, documentName: '冷却.md' } as never)
      expect(spy).toHaveBeenCalledTimes(1)
      const dirty2 = new Y.Doc()
      Y.applyUpdate(dirty2, await mdToUpdate('# 冷却\n\n段落一\n\n段落二\n\n![](y)\n'))
      ensureState('冷却.md')
      await collabHooks.onStoreDocument!({ document: dirty2, documentName: '冷却.md' } as never)
      expect(spy).toHaveBeenCalledTimes(1) // 冷却拦截
    } finally {
      closeSpy.mockRestore()
      spy.mockRestore()
    }
  }, 10_000)
})
