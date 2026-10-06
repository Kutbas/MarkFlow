import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const seedsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../seeds',
)

/**
 * 首次启动播种：NOTES_DIR / THEMES_DIR 为空目录时，
 * 把仓库内 seeds/ 的示例笔记与内置主题复制进去，保证开箱即用。
 */
export async function seedIfEmpty(): Promise<void> {
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
