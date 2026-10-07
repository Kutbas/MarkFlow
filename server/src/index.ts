import http from 'node:http'
import os from 'node:os'
import { config } from './config.js'
import { seedIfEmpty } from './bootstrap.js'
import { createApp } from './app.js'
import { startNoteWatcher } from './files/watcher.js'
import { hocuspocus, shutdownCollab } from './collab/hocuspocus.js'
import { attachCollab } from './collab/ws.js'
import { startExternalSync } from './collab/externalSync.js'

async function main() {
  await seedIfEmpty()

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
  })

  // 文件监听与外部同步仅磁盘模式（PG 模式无磁盘文件可监听）
  if (config.storage === 'fs') {
    startNoteWatcher()
    startExternalSync()
  }

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
