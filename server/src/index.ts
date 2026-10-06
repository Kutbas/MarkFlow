import http from 'node:http'
import express from 'express'
import os from 'node:os'
import { config } from './config.js'
import { seedIfEmpty } from './bootstrap.js'

async function main() {
  await seedIfEmpty()

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'MarkFlow', time: new Date().toISOString() })
  })

  // 单一 http.Server：IPv6 全零地址双栈监听，Express(HTTP) 与后续 Hocuspocus(WS) 共端口
  const server = http.createServer(app)
  server.listen(config.port, config.host, () => {
    const v4: string[] = []
    const v6: string[] = []
    for (const ifaces of [os.networkInterfaces()['en0'] ?? []]) {
      for (const addr of ifaces) {
        if (addr.family === 'IPv4') v4.push(addr.address)
        else v6.push(addr.address)
      }
    }
    console.log(`[MarkFlow] 监听 [${config.host}]:${config.port}（双栈）`)
    console.log(`[MarkFlow] 笔记目录: ${config.notesDir}`)
    console.log(`[MarkFlow] 主题目录: ${config.themesDir}`)
    console.log(`[MarkFlow] 本机访问: http://127.0.0.1:${config.port} / http://[::1]:${config.port}`)
    for (const a of v4) console.log(`[MarkFlow] IPv4 局域网: http://${a}:${config.port}`)
    for (const a of v6) console.log(`[MarkFlow] IPv6 局域网: http://[${a}]:${config.port}`)
  })
}

main().catch((err) => {
  console.error('[MarkFlow] 启动失败:', err)
  process.exit(1)
})
