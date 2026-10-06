import fs from 'node:fs'
import { Hocuspocus, type Extension } from '@hocuspocus/server'
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
 * 延迟播种窗口（毫秒）：服务端进程重启后内存协同树为空，此时若有持有旧状态的
 * 客户端重连，应让它先把内容送回（同 ID 幂等合并）；若立刻按磁盘重新播种，
 * 新内容会使用全新 Yjs ID，与客户端送回的旧 ID 内容合并后**成倍复制**。
 * 窗口内文档仍为空才播种（真正的新开场景）。
 */
const SEED_GRACE_MS = Number.parseInt(process.env.MF_SEED_GRACE_MS ?? '800', 10) || 800

/** 防止同一文档在窗口期内重复调度播种 */
const seedPending = new Set<string>()

function scheduleSeed(documentName: string, document: Y.Doc, md: string): void {
  if (seedPending.has(documentName)) return
  seedPending.add(documentName)
  setTimeout(async () => {
    try {
      // 等待窗口：重连客户端的 state 同步在此期间完成
      await new Promise((r) => setTimeout(r, SEED_GRACE_MS))
      if (document.getXmlFragment('prosemirror').length === 0) {
        Y.applyUpdate(document, await mdToUpdate(md), 'markflow-load')
      }
    } catch (err) {
      console.error('[MarkFlow] 播种失败:', documentName, err)
    } finally {
      seedPending.delete(documentName)
    }
  }, 0).unref?.()
}

/**
 * 协同服务端：与 Express 共用 8080 端口（crossws upgrade）。
 * - onConnect：Cookie JWT 鉴权门（未登录直接断开）
 * - onLoadDocument：读磁盘 .md → Yjs 协同树（延迟播种，见 scheduleSeed）
 * - onStoreDocument：防抖落盘（停止输入 1.5s / 最长 5s，PRD 规格）
 * 钩子独立导出以便单元测试直接调用。
 */
export const collabHooks: Partial<Extension> = {
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
    if (!fs.existsSync(abs)) {
      // 文件不存在（新建未落盘/外部已删）：保持空协同树，首次落盘时创建
      recordDiskBaseline(rel)
      return
    }
    const md = fs.readFileSync(abs, 'utf8')
    recordDiskBaseline(rel)
    // 已有内容（客户端重连已带回 / 同进程内已播种）→ 无需处理
    if (document.getXmlFragment('prosemirror').length > 0) return
    // 立即返回建立连接，让客户端 state 先行；窗口期内仍为空才播种
    scheduleSeed(documentName, document, md)
  },

  async onStoreDocument({ document, documentName }) {
    const rel = docNameToRel(documentName)
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
}

export const hocuspocus = new Hocuspocus({
  quiet: true,
  debounce: config.flushDebounce.waitMs,
  maxDebounce: config.flushDebounce.maxWaitMs,
  unloadImmediately: false,
  ...collabHooks,
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

/** 优雅停机：冲刷全部挂起落盘（配合 SIGTERM/SIGINT，避免强杀丢数据） */
export async function shutdownCollab(): Promise<void> {
  hocuspocus.flushPendingStores()
  // 等待进行中的异步落盘完成
  await new Promise((r) => setTimeout(r, 150))
}
