import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

/** seeds 目录候选：开发模式 <repo>/seeds；bundle 模式 /app/seeds（Dockerfile 放置） */
function findSeedsDir(): string | null {
  const candidates = [
    process.env.SEEDS_DIR,
    path.resolve(serverDir, '../../seeds'), // dev: server/src → repo/seeds；bundle: dist → /seeds
    '/app/seeds', // 生产容器固定位置
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 首次启动播种：NOTES_DIR / THEMES_DIR 为空目录时，
 * 把仓库内 seeds/ 的示例笔记与内置主题复制进去，保证开箱即用。
 */
export async function seedIfEmpty(): Promise<void> {
  const seedsDir = findSeedsDir()
  if (!seedsDir) return
  for (const [seedSrc, target] of [
    [path.join(seedsDir, 'notes'), config.notesDir],
    [path.join(seedsDir, 'themes'), config.themesDir],
  ] as const) {
    fs.mkdirSync(target, { recursive: true })
    const existing = fs.readdirSync(target)
    if (existing.length > 0 || !fs.existsSync(seedSrc)) continue
    fs.cpSync(seedSrc, target, { recursive: true })
    console.log(`[MarkFlow] 已播种示例数据: ${target}`)
  }
}

