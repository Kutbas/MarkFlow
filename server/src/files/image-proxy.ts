import { Router } from 'express'

/**
 * 图片代理：许多图床（如腾讯云 COS）开启 Referer 防盗链，
 * 浏览器直接引用会被 403。服务端转发不带 Referer 即可通过白名单。
 * 仅允许 http/https 且仅放行 image/* 响应，透传流式内容并长缓存。
 */
export const imageProxyRouter = Router()

/** 上游 fetch 可注入（测试替换；默认原生 fetch，不带 Referer） */
export const proxyDeps: {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>
} = {
  fetch: (url, init) => fetch(url, init),
}

const CACHE_MS = 7 * 24 * 3600 // 图床 URL 内容不可变，缓存一周

imageProxyRouter.get('/img', async (req, res) => {
  const raw = String(req.query.u ?? '')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    res.status(400).json({ error: '非法图片地址' })
    return
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.status(400).json({ error: '仅支持 http/https 图片' })
    return
  }

  try {
    const upstream = await proxyDeps.fetch(target, {
      // 关键：不带 Referer（绕过图床防盗链白名单）
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    })
    const contentType = upstream.headers.get('content-type') ?? ''
    if (!upstream.ok || !contentType.startsWith('image/')) {
      res.status(502).json({ error: `图床返回异常（${upstream.status}）` })
      return
    }
    res.status(200)
      .type(contentType)
      .set('Cache-Control', `private, max-age=${CACHE_MS}, immutable`)
      .set('X-MarkFlow-Proxy', '1')
    if (upstream.body) {
      const buf = new Uint8Array(await upstream.arrayBuffer())
      res.end(Buffer.from(buf))
    } else {
      res.end()
    }
  } catch (err) {
    console.error('[MarkFlow] 图片代理失败:', target.host, (err as Error).message)
    res.status(504).json({ error: '图片代理获取失败' })
  }
})
