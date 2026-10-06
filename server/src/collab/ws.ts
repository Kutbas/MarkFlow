import type { Server as HttpServer } from 'node:http'
import crossws from 'crossws/adapters/node'
import type { Hocuspocus } from '@hocuspocus/server'

/**
 * 将 Hocuspocus 协同服务挂到现有的 http.Server 上（与 Express 共端口）。
 * WebSocket 路径固定为 /collab；documentName 由客户端在消息内携带（v4 多路复用）。
 */
export function attachCollab(server: HttpServer, hocuspocus: Hocuspocus): void {
  const ws = crossws({
    hooks: {
      open: (peer) => {
        const cc = hocuspocus.handleConnection(
          peer.websocket as never,
          peer.request as never,
        )
        ;(peer as unknown as Record<string, unknown>)['_mfCC'] = cc
      },
      message: (peer, message) => {
        const cc = (peer as unknown as Record<string, { handleMessage: (data: Uint8Array) => void }>)['_mfCC']
        cc?.handleMessage(message.uint8Array())
      },
      close: (peer, details) => {
        const cc = (peer as unknown as Record<string, { handleClose: (d: unknown) => void }>)['_mfCC']
        cc?.handleClose(details)
      },
      error: (_peer, error) => {
        console.error('[MarkFlow] WebSocket 错误:', error)
      },
    },
  })

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://internal')
    if (pathname === '/collab') {
      ws.handleUpgrade(request, socket, head)
    } else {
      socket.destroy()
    }
  })
}
