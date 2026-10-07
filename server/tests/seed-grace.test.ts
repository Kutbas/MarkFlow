/**
 * 延迟播种 + 守卫（PG 权威状态模式下的窗口语义）。
 * pglite 由全局 setup 注入；MF_SEED_GRACE_MS 已在 helpers 里缩短。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { collabHooks, hocuspocus } from '../src/collab/hocuspocus.js'
import { ensureState } from '../src/collab/docRegistry.js'
import { mdToUpdate, yDocToMd } from '../src/interop/index.js'

type Ad = { createFile(p: string, md: string): Promise<void>; exists(p: string): Promise<boolean>; readMarkdown(p: string): Promise<string> }
const g = globalThis as unknown as { __pgAdapter: Ad }
const GRACE = 150

async function wait(ms: number) { await new Promise((r) => setTimeout(r, ms)) }

describe('延迟播种（seed grace）', () => {
  it('空文档 + 无客户端内容 → 窗口期后播种一次', async () => {
    await g.__pgAdapter.createFile('播种a.md', '# 播种A\n\n内容\n').catch(() => {})
    ensureState('播种a.md')
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种a.md' } as never)
    expect(doc.getXmlFragment('prosemirror').length).toBe(0)
    await wait(GRACE + 400)
    expect(await yDocToMd(doc)).toContain('# 播种A')
  }, 10_000)

  it('重连客户端在窗口期内带回内容 → 不再播种（零复制）', async () => {
    await g.__pgAdapter.createFile('播种b.md', '# 播种B\n\n内容\n').catch(() => {})
    ensureState('播种b.md')
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种b.md' } as never)
    const clientDoc = new Y.Doc()
    Y.applyUpdate(clientDoc, await mdToUpdate('# 播种B\n\n内容\n'))
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(clientDoc))
    await wait(GRACE + 400)
    const md = await yDocToMd(doc)
    expect((md.match(/^# /gm) ?? []).length).toBe(1)
  }, 10_000)

  it('同一文档重复 onLoadDocument 只调度一次', async () => {
    await g.__pgAdapter.createFile('播种c.md', '# 播种C\n').catch(() => {})
    ensureState('播种c.md')
    const doc = new Y.Doc()
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种c.md' } as never)
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种c.md' } as never)
    await wait(GRACE + 400)
    expect(((await yDocToMd(doc)).match(/^# /gm) ?? []).length).toBe(1)
  }, 10_000)

  it('已有内容的文档直接返回', async () => {
    await g.__pgAdapter.createFile('播种d.md', '# 磁盘D\n').catch(() => {})
    ensureState('播种d.md')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await mdToUpdate('# 客户端已有D\n'))
    await collabHooks.onLoadDocument!({ document: doc, documentName: '播种d.md' } as never)
    expect(doc.getXmlFragment('prosemirror').toString()).toContain('客户端已有D')
    await wait(GRACE + 300)
    expect(await yDocToMd(doc)).not.toContain('磁盘D')
  }, 10_000)

  it('shutdownCollab 冲刷挂起落盘', async () => {
    const { shutdownCollab } = await import('../src/collab/hocuspocus.js')
    const spy = vi.spyOn(hocuspocus, 'flushPendingStores').mockImplementation(() => {})
    await shutdownCollab()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('异常状态守卫', () => {
  it('空图片节点：拒绝落库、断开并广播', async () => {
    await g.__pgAdapter.createFile('守卫a.md', '# 守卫A\n\n正文一段\n').catch(() => {})
    ensureState('守卫a.md')
    const dirty = new Y.Doc()
    Y.applyUpdate(dirty, await mdToUpdate('# 守卫A\n\n正文一段\n\n![](x)\n'))
    const { sseHub } = await import('../src/events.js')
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const bcastSpy = vi.spyOn(sseHub, 'broadcast').mockImplementation(() => {})
    try {
      const before = await g.__pgAdapter.readMarkdown('守卫a.md')
      await collabHooks.onStoreDocument!({ document: dirty, documentName: '守卫a.md' } as never)
      expect(await g.__pgAdapter.readMarkdown('守卫a.md')).toBe(before)
      expect(closeSpy).toHaveBeenCalledWith('守卫a.md')
      expect(bcastSpy).toHaveBeenCalledWith('doc-reset', { path: '守卫a.md' })
    } finally {
      closeSpy.mockRestore()
      bcastSpy.mockRestore()
    }
  }, 10_000)

  it('整倍内容（用户全选复制）属合法编辑：正常落库', async () => {
    const single = '# 守卫B\n\n段落一\n\n段落二\n\n段落三\n'
    await g.__pgAdapter.createFile('守卫b.md', single).catch(() => {})
    ensureState('守卫b.md')
    const doubled = new Y.Doc()
    Y.applyUpdate(doubled, await mdToUpdate(single + '\n' + single + '\n' + single))
    await collabHooks.onStoreDocument!({ document: doubled, documentName: '守卫b.md' } as never)
    expect(await g.__pgAdapter.readMarkdown('守卫b.md')).toContain('段落三')
  }, 10_000)

  it('冷却期内第二次异常静默跳过', async () => {
    await g.__pgAdapter.createFile('冷却.md', '# 冷却\n\n段落\n').catch(() => {})
    ensureState('冷却.md')
    const dirty = new Y.Doc()
    Y.applyUpdate(dirty, await mdToUpdate('# 冷却\n\n段落\n\n![](x)\n'))
    const { sseHub } = await import('../src/events.js')
    const closeSpy = vi.spyOn(hocuspocus, 'closeConnections').mockImplementation(() => {})
    const spy = vi.spyOn(sseHub, 'broadcast').mockImplementation(() => {})
    try {
      await collabHooks.onStoreDocument!({ document: dirty, documentName: '冷却.md' } as never)
      expect(spy).toHaveBeenCalledTimes(1)
      const dirty2 = new Y.Doc()
      Y.applyUpdate(dirty2, await mdToUpdate('# 冷却\n\n段落\n\n![](y)\n'))
      ensureState('冷却.md')
      await collabHooks.onStoreDocument!({ document: dirty2, documentName: '冷却.md' } as never)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      closeSpy.mockRestore()
      spy.mockRestore()
    }
  }, 10_000)
})
