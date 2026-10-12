import express, { Router } from 'express'
import { getStorage } from '../storage/index.js'

/** 允许上传的图片类型（与 pg-adapter 的 IMAGE_EXT_OF_MIME 一致；不含 svg——防脚本注入） */
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
])

export const imagesRouter = Router()

/**
 * POST /api/images — 上传粘贴的本地图片（截图等）。
 * body 为原始二进制（express.raw），Content-Type 即图片 MIME。
 * 返回 { url: '/api/images/<uuid>.<ext>' }，前端插入 <img>。
 */
imagesRouter.post(
  '/images',
  express.raw({ type: 'image/*', limit: '10mb' }),
  async (req, res) => {
    const mime = req.headers['content-type'] ?? ''
    if (!ALLOWED_IMAGE_MIME.has(mime)) {
      res.status(415).json({ error: '仅支持 png / jpeg / gif / webp / bmp / avif 图片' })
      return
    }
    const buf = req.body
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      res.status(400).json({ error: '图片内容为空' })
      return
    }
    const id = await (await getStorage()).saveImage(mime, buf)
    res.status(201).json({ url: `/api/images/${id}` })
  },
)

/** GET /api/images/:id — 读取图片（同源 <img> 自动带 cookie；一年 immutable 缓存） */
imagesRouter.get('/images/:id', async (req, res) => {
  const img = await (await getStorage()).readImage(String(req.params.id ?? ''))
  if (!img) {
    res.status(404).json({ error: '图片不存在' })
    return
  }
  res
    .type(img.mime)
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .send(Buffer.from(img.bytes))
})
