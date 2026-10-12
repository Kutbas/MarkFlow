import http from 'node:http'
import os from 'node:os'
import { config } from './config.js'
import { seedIfEmpty } from './bootstrap.js'
import { createApp } from './app.js'
import { getStorage } from './storage/index.js'
import { hocuspocus, shutdownCollab } from './collab/hocuspocus.js'
import type { StorageAdapter } from './storage/types.js'
import { attachCollab } from './collab/ws.js'

async function main() {
  await seedIfEmpty()

  // 提前初始化存储（DATABASE_URL 缺失时立即报错）
  await getStorage()
  const app = createApp()
  // 单一 http.Server：IPv6 全零地址双栈监听，Express(HTTP) 与 Hocuspocus(WS) 共端口
  const server = http.createServer(app)
  attachCollab(server, hocuspocus)
  server.listen(config.port, config.host, () => {
    console.log(`[MarkFlow] 监听 [${config.host}]:${config.port}（双栈）`)
    console.log(`[MarkFlow] 笔记目录: ${config.notesDir}`)
    console.log(`[MarkFlow] 主题目录: ${config.themesDir}`)
    console.log(`[MarkFlow] 本机访问: http://127.0.0.1:${config.port} / http://[::1]:${config.port}`)
    const en0 = os.networkInterfaces().en0 ?? []
    for (const addr of en0) {
      const label = addr.family === 'IPv4' ? 'IPv4 局域网' : 'IPv6 局域网'
      const host = addr.family === 'IPv4' ? addr.address : `[${addr.address}]`
      console.log(`[MarkFlow] ${label}: http://${host}:${config.port}`)
    }

  // 图片回收：文档中已无引用且超过宽限期的粘贴图片定时清理（防垃圾堆积；
  // 宽限期 24h 保护"删除后反悔 Cmd+Z"场景；失败不影响服务）
  const IMAGE_GC_GRACE_MS = 24 * 3600 * 1000
  const IMAGE_GC_INTERVAL_MS = 6 * 3600 * 1000
  const runImageGc = async (): Promise<void> => {
    try {
      const storage = (await getStorage()) as StorageAdapter & { gcImages(ms: number): Promise<number> }
      const n = await storage.gcImages(IMAGE_GC_GRACE_MS)
      if (n > 0) console.log(`[MarkFlow] 图片回收：清理 ${n} 张未引用图片`)
    } catch (err) {
      console.warn('[MarkFlow] 图片回收失败（下次重试）：', err)
    }
  }
  setTimeout(runImageGc, 60_000).unref?.()
  setInterval(runImageGc, IMAGE_GC_INTERVAL_MS).unref?.()
  })



  // 优雅停机：先冲刷挂起的防抖落盘再退出，避免强杀丢失最近编辑
  const shutdown = async (signal: string) => {
    console.log(`[MarkFlow] 收到 ${signal}，冲刷落盘后退出…`)
    try {
      await shutdownCollab()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[MarkFlow] 启动失败:', err)
  process.exit(1)
})
