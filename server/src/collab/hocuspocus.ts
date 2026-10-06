import fs from 'node:fs'
import { Hocuspocus } from '@hocuspocus/server'
import * as Y from 'yjs'
import { config } from '../config.js'
import { identityFromHeaders } from '../auth/service.js'
import { mdToUpdate, yDocToMd } from '../interop/index.js'
import { sseHub } from '../events.js'
import { atomicWrite, sha1 } from '../util/atomicWrite.js'
import {
  docNameToRel,
  ensureState,
  forgetState,
  getLastKnownHash,
  recordDiskBaseline,
  relToAbs,
  relToDocName,
  setLastKnownHash,
} from './docRegistry.js'

/**
 * 协同服务端：与 Express 共用 8080 端口（crossws upgrade）。
 * - onConnect：Cookie JWT 鉴权门（未登录直接断开）
 * - onLoadDocument：读磁盘 .md → Yjs 协同树（首次/重新加载时播种）
 * - onStoreDocument：防抖落盘（停止输入 1.5s / 最长 5s，PRD 规格）
 */
export const hocuspocus = new Hocuspocus({
  quiet: true,
  debounce: config.flushDebounce.waitMs,
  maxDebounce: config.flushDebounce.maxWaitMs,
  unloadImmediately: false,

  async onConnect({ requestHeaders }) {
    const cookie = requestHeaders.get('cookie') ?? undefined
    const authorization = requestHeaders.get('authorization') ?? undefined
    const user = await identityFromHeaders({ cookie, authorization })
    if (!user) throw new Error('未登录')
  },

  async onLoadDocument({ document, documentName }) {
    const rel = docNameToRel(documentName)
    ensureState(rel)
    const abs = relToAbs(rel)
    if (process.env.MF_DEBUG) {
      console.log(`[debug onLoadDocument] ${rel} exists=${fs.existsSync(abs)} 当前树长度=${document.getXmlFragment('prosemirror').length}`)
    }
    if (!fs.existsSync(abs)) {
      // 文件不存在（新建未落盘/外部已删）：保持空协同树，首次落盘时创建
      recordDiskBaseline(rel)
      return
    }
    const md = fs.readFileSync(abs, 'utf8')
    recordDiskBaseline(rel)
    // 仅在协同树为空时播种（重连场景已有内容则跳过，避免重复插入）
    if (document.getXmlFragment('prosemirror').length === 0) {
      const update = await mdToUpdate(md)
      Y.applyUpdate(document, update, 'markflow-load')
      if (process.env.MF_DEBUG) {
        console.log(`[debug onLoadDocument] 已播种 ${rel} update=${update.byteLength}B 播种后长度=${document.getXmlFragment('prosemirror').length}`)
      }
    }
  },

  async onStoreDocument({ document, documentName }) {
    const rel = docNameToRel(documentName)
    if (process.env.MF_DEBUG) {
      console.log(`[debug onStoreDocument] ${rel} 树长度=${document.getXmlFragment('prosemirror').length}`)
    }
    const abs = relToAbs(rel)
    if (!fs.existsSync(abs)) {
      // 文件已被外部删除或改名：放弃落盘，断开该文档的所有连接
      console.warn(`[MarkFlow] 落盘中止（文件已不存在）: ${rel}`)
      hocuspocus.closeConnections(documentName)
      await hocuspocus.unloadDocument(document)
      forgetState(rel)
      sseHub.broadcast('doc-gone', { path: rel })
      return
    }
    const md = await yDocToMd(document)
    const hash = sha1(md)
    if (hash === getLastKnownHash(rel)) return // 内容未变化
    await atomicWrite(abs, md)
    setLastKnownHash(rel, hash)
  },
})

/** 供文件 CRUD 路由调用的文档下线：先冲刷挂起的落盘，再断开并卸载 */
export async function retireDoc(relPath: string): Promise<void> {
  const docName = relToDocName(relPath)
  const doc = hocuspocus.documents.get(docName)
  if (doc) {
    hocuspocus.flushPendingStores()
    hocuspocus.closeConnections(docName)
    await hocuspocus.unloadDocument(doc)
  }
  forgetState(relPath)
}
