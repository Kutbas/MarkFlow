import type { Response } from 'express'

/**
 * SSE 事件枢纽：向所有在线页面广播文件树/协同相关事件。
 * 客户端订阅 GET /api/events（EventSource）。
 */
class SseHub {
  private clients = new Set<Response>()

  subscribe(res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
    res.on('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(res)
    })
  }

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) {
      try {
        res.write(payload)
      } catch {
        this.clients.delete(res)
      }
    }
  }
}

export const sseHub = new SseHub()
