import { Hocuspocus, type Extension } from '@hocuspocus/server'
import * as Y from 'yjs'
import { config } from '../config.js'
import { identityFromHeaders } from '../auth/service.js'
import { mdToUpdate, yDocToMd } from '../interop/index.js'
import { sseHub } from '../events.js'
import { sha1 } from '../util/atomicWrite.js'
import { getStorage } from '../storage/index.js'
import {
  docNameToRel,
  ensureState,
  forgetState,
  getLastKnownHash,
  relToDocName,
  setLastKnownHash,
} from './docRegistry.js'

/**
 * 延迟播种（安静窗口策略）：服务端进程重启后内存协同树为空，若有持有旧状态的
 * 客户端重连，应让它先把内容送回（同 ID 幂等合并）；若立刻按 md 重新播种，
 * 新内容使用全新 Yjs ID，与客户端送回的旧 ID 内容合并后会**成倍复制**。
 *
 * 播种条件 = 文档为空 且 已连续 SEED_GRACE_MS 无新连接。
 * 每次新连接都顺延播种（连接意味着可能有带状态的客户端即将送回内容，
 * 大文档的状态上传+应用可达秒级，固定短窗口会输掉竞态——线上已发生 245→490 翻倍）。
 */
const SEED_GRACE_MS = Number.parseInt(process.env.MF_SEED_GRACE_MS ?? '2000', 10) || 2000

/** docName → 播种计时器 */
const seedTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleSeed(documentName: string, document: Y.Doc, md: string): void {
  // 重置计时：从"现在"起再等一个完整安静窗口
  const existing = seedTimers.get(documentName)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(async () => {
    seedTimers.delete(documentName)
    try {
      if (document.getXmlFragment('prosemirror').length === 0) {
        Y.applyUpdate(document, await mdToUpdate(md), 'markflow-load')
      }
    } catch (err) {
      console.error('[MarkFlow] 播种失败:', documentName, err)
    }
  }, SEED_GRACE_MS)
  timer.unref?.()
  seedTimers.set(documentName, timer)
}

/** 异常状态重置冷却：同一文档 10 秒内不重复广播，防止抖动造成页面闪烁 */
const resetCooldown = new Map<string, number>()
const RESET_COOLDOWN_MS = 10_000

/** 播种完成/取消后清理 */
function cancelSeed(documentName: string): void {
  const existing = seedTimers.get(documentName)
  if (existing) {
    clearTimeout(existing)
    seedTimers.delete(documentName)
  }
}

/**
 * 协同服务端：与 Express 共用 8080 端口（crossws upgrade）。
 * - onConnect：Cookie JWT 鉴权门（未登录直接断开）
 * - onLoadDocument：从数据库恢复 Yjs 权威状态 / 无状态时按 md 播种（延迟，见 scheduleSeed）
 * - onStoreDocument：防抖落盘（停止输入 1.5s / 最长 5s，PRD 规格）
 * 钩子独立导出以便单元测试直接调用。
 */
export const collabHooks: Partial<Extension> = {
  async onConnect({ requestHeaders, documentName }) {
    const cookie = requestHeaders.get('cookie') ?? undefined
    const authorization = requestHeaders.get('authorization') ?? undefined
    const user = await identityFromHeaders({ cookie, authorization })
    if (!user) throw new Error('未登录')
    // 新连接到达：该文档若在等待播种，顺延一个安静窗口（防重连竞态翻倍）
    const doc = hocuspocus.documents.get(documentName)
    const timer = seedTimers.get(documentName)
    if (doc && timer && doc.getXmlFragment('prosemirror').length === 0) {
      const rel = docNameToRel(documentName)
      const storage = await getStorage()
      const md = await storage.readMarkdown(rel).catch(() => null)
      if (md !== null) scheduleSeed(documentName, doc, md)
    }
  },

  async onLoadDocument({ document, documentName }) {
    const rel = docNameToRel(documentName)
    ensureState(rel)
    const storage = await getStorage()

    // 1) 权威 Yjs 状态存在（PG 模式 / FsAdapter 状态目录）→ 直接恢复，保留 CRDT 身份
    const saved = await storage.loadYjsState(rel)
    if (saved && saved.length > 1) {
      Y.applyUpdate(document, saved, 'markflow-restore')
      const md = await storage.readMarkdown(rel).catch(() => '')
      setLastKnownHash(rel, sha1(md))
      return
    }

    // 2) 无状态：延迟播种（安静窗口，防重连竞态翻倍——见 scheduleSeed 注释）
    let md: string
    try {
      md = await storage.readMarkdown(rel)
    } catch {
      // 文件不存在（新建未落盘）：保持空协同树
      return
    }
    setLastKnownHash(rel, sha1(md))
    if (document.getXmlFragment('prosemirror').length > 0) {
      cancelSeed(documentName)
      return
    }
    scheduleSeed(documentName, document, md)
  },

  async onStoreDocument({ document, documentName }) {
    const rel = docNameToRel(documentName)
    const storage = await getStorage()

    if (!(await storage.exists(rel))) {
      // 文件已被删除或改名：放弃落盘，断开该文档的所有连接
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

    // ---- 异常协同状态守卫（空图片指纹，双模式通用）----
    if (isCorruptedState(md)) {
      const lastReset = resetCooldown.get(rel) ?? 0
      const now = Date.now()
      if (now - lastReset < RESET_COOLDOWN_MS) return
      resetCooldown.set(rel, now)
      console.warn(`[MarkFlow] 检测到异常协同状态（空图片节点）: ${rel}`)
      // 不写库，等待下一轮干净的 store；断开重连让客户端按权威状态恢复
      hocuspocus.closeConnections(documentName)
      forgetState(rel)
      sseHub.broadcast('doc-reset', { path: rel })
      return
    }

    // 权威状态落库：Yjs 二进制 + md 缓存
    await storage.saveYjsState(rel, Y.encodeStateAsUpdate(document), md)
    setLastKnownHash(rel, hash)
  },
}

/** 异常状态判定：无源图片（alt 可为空是合法写法，只有 src 为空才是脏状态指纹） */
function isCorruptedState(md: string): boolean {
  return /!\[[^\]]*\]\(\s*\)/.test(md)
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
