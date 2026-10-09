import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getStorage } from './storage/index.js'

const seedsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../seeds',
)

function findSeedsDir(): string | null {
  const candidates = [
    process.env.SEEDS_DIR,
    seedsDir, // dev: server/src → repo/seeds
    '/app/seeds', // 生产容器固定位置
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 内置主题播种：把 seeds/themes/*.css 复制进主题目录（生产容器里是卷）。
 * 增量复制——已存在的文件不覆盖（用户手动放入/改过的主题永远优先），
 * 因此升级镜像带来新内置主题时也能自动补齐。每次启动都跑（幂等）。
 */
function seedThemes(seedsRoot: string, themesDir: string): void {
  const seedThemesDir = path.join(seedsRoot, 'themes')
  if (!fs.existsSync(seedThemesDir)) return
  fs.mkdirSync(themesDir, { recursive: true })
  for (const entry of fs.readdirSync(seedThemesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.css$/i.test(entry.name)) continue
    const target = path.join(themesDir, entry.name)
    if (fs.existsSync(target)) continue
    fs.copyFileSync(path.join(seedThemesDir, entry.name), target)
  }
}

/**
 * 首次启动播种：数据库 files 表为空时，把仓库内 seeds/ 的示例笔记写入 PG。
 */
export async function seedIfEmpty(): Promise<void> {
  const seedsRoot = findSeedsDir()
  if (!seedsRoot) return
  const { config } = await import('./config.js')
  seedThemes(seedsRoot, config.themesDir)

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
  const notesSeedDir = path.join(seedsRoot, 'notes')
  if (fs.existsSync(notesSeedDir)) {
    walk(notesSeedDir, '')
    await Promise.all(ops)
    console.log('[MarkFlow] 已播种示例数据到 PostgreSQL')
  }
}
