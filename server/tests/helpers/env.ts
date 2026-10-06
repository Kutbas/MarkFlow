/** API 集成测试的独立环境：必须在导入任何 src 模块之前先 import 本文件 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-api-'))

export const notesDir = path.join(tmpRoot, 'notes')
export const themesDir = path.join(tmpRoot, 'themes')

fs.mkdirSync(path.join(notesDir, '子目录'), { recursive: true })
fs.writeFileSync(path.join(notesDir, '首页.md'), '# 首页\n\n你好 MarkFlow\n')
fs.writeFileSync(path.join(notesDir, '子目录/笔记.md'), '# 笔记\n')
fs.mkdirSync(themesDir, { recursive: true })
fs.writeFileSync(path.join(themesDir, 'demo.css'), 'body { color: red }')

// 在 config.ts 模块求值前覆盖环境变量（进程 env 优先于 .env 文件）
process.env.NOTES_DIR = notesDir
process.env.THEMES_DIR = themesDir
process.env.AUTH_USERS = 'alice:alice123'
