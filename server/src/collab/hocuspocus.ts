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
 * 延迟播种（安静窗口策略）：服务端进程重启后内存协同树为空，若有持有旧状态的
 * 客户端重连，应让它先把内容送回（同 ID 幂等合并）；若立刻按磁盘重新播种，
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
 * - onLoadDocument：读磁盘 .md → Yjs 协同树（延迟播种，见 scheduleSeed）
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
      const abs = relToAbs(docNameToRel(documentName))
      if (fs.existsSync(abs)) {
        scheduleSeed(documentName, doc, fs.readFileSync(abs, 'utf8'))
      }
    }
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
    // 已有内容（客户端重连已带回 / 同进程内已播种）→ 取消等待中的播种
    if (document.getXmlFragment('prosemirror').length > 0) {
      cancelSeed(documentName)
      return
    }
    // 立即返回建立连接，让客户端 state 先行；安静窗口后仍为空才播种
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

    // ---- 异常协同状态守卫 ----
    // 事故特征：历史 bug（重启重播种翻倍）污染过的客户端会把"空图片节点 /
    // 磁盘内容整倍复制"的状态推回服务端。检测到即以磁盘为真相重置协同树
    // 并广播，所有在线端自动恢复；绝不把异常状态写进磁盘。
    const diskMd = fs.readFileSync(abs, 'utf8')
    if (isCorruptedState(md, diskMd)) {
      console.warn(`[MarkFlow] 检测到异常协同状态，已按磁盘重置: ${rel}`)
      const update = await mdToUpdate(diskMd)
      document.transact(() => {
        const fragment = document.getXmlFragment('prosemirror')
        fragment.delete(0, fragment.length)
        Y.applyUpdate(document, update, 'markflow-reset')
      })
      setLastKnownHash(rel, sha1(diskMd))
      sseHub.broadcast('doc-reset', { path: rel })
      return
    }

    await atomicWrite(abs, md)
    setLastKnownHash(rel, hash)
  },
}

/**
 * 异常状态判定：空图片（合法 Markdown 不会产生无源图片），或
 * 标题数达到磁盘的整倍（≥2 倍）且总文本更长——翻倍复制的指纹。
 */
function isCorruptedState(md: string, diskMd: string): boolean {
  if (/!\[\]\([^)]*\)/.test(md)) return true
  const h1 = (s: string) => (s.match(/^# /gm) ?? []).length
  const diskH1 = h1(diskMd)
  // H1 数较磁盘翻倍且多出至少 3 个（防止"用户加了两个标题"误伤），同时总长 1.8 倍以上
  if (diskH1 >= 1 && h1(md) >= Math.max(diskH1 * 2, diskH1 + 2) && md.length > diskMd.length * 1.8)
    return true
  return false
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
