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
  if (config.storage === 'postgres') {
    await seedPostgres(path.join(seedsDir, 'notes'))
    return
  }
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

/** PG 模式：files 表为空时把 seeds 递归写入 */
async function seedPostgres(notesSeedDir: string): Promise<void> {
  const { getStorage } = await import('./storage/index.js')
  const storage = await getStorage()
  const tree = await storage.readTree()
  if (tree.length > 0) return
  const ops: Promise<void>[] = []
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        ops.push(storage.createFolder(relPath).catch(() => {}))
        walk(path.join(dir, entry.name), relPath)
      } else if (/\.md$/i.test(entry.name)) {
        const md = fs.readFileSync(path.join(dir, entry.name), 'utf8')
        ops.push(storage.createFile(relPath, md).catch(() => {}))
      }
    }
  }
  if (fs.existsSync(notesSeedDir)) {
    walk(notesSeedDir, '')
    await Promise.all(ops)
    console.log('[MarkFlow] 已播种示例数据到 PostgreSQL')
  }
}

