import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))

/** 加载 .env（不存在则静默跳过；已存在的进程环境变量优先） */
function loadDotEnv(): void {
  try {
    // MF_ENV_FILE 可覆盖 env 文件位置（测试与容器场景）
    const envFile = process.env.MF_ENV_FILE ?? path.resolve(serverDir, '../../.env')
    process.loadEnvFile(envFile)
  } catch {
    // 无 .env 文件时忽略
  }
}
loadDotEnv()

function int(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export interface AuthUser {
  name: string
  /** bcrypt 哈希（$2 开头）或明文口令，由 auth 模块统一处理 */
  secret: string
}

/** 解析 AUTH_USERS="alice:pass,bob:$2a$..."（逗号分隔，密码内不含逗号） */
function parseUsers(): AuthUser[] {
  const raw = process.env.AUTH_USERS ?? 'admin:admin123'
  const users = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':')
      if (idx <= 0) {
        throw new Error(`AUTH_USERS 条目格式错误（应为 用户名:密码）: ${entry}`)
      }
      return { name: entry.slice(0, idx), secret: entry.slice(idx + 1) }
    })
  if (users.length === 0) throw new Error('AUTH_USERS 不能为空')
  return users
}

const repoRoot = path.resolve(serverDir, '../..')

export const config = {
  port: int('PORT', 8080),
  /** IPv6 全零地址 = 双栈监听（内核自动兼容 IPv4-mapped 入站） */
  host: process.env.HOST ?? '::',
  notesDir: path.resolve(repoRoot, process.env.NOTES_DIR ?? './data/notes'),
  themesDir: path.resolve(repoRoot, process.env.THEMES_DIR ?? './data/themes'),
  webDist: path.resolve(repoRoot, process.env.WEB_DIST ?? './web/dist'),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret',
  users: parseUsers(),
  /** 协同落盘防抖（PRD：停止输入 1.5s，或 5s 固定周期） */
  flushDebounce: {
    waitMs: int('FLUSH_DEBOUNCE_WAIT_MS', 1500),
    maxWaitMs: int('FLUSH_DEBOUNCE_MAX_WAIT_MS', 5000),
  },
  isDev: process.env.NODE_ENV !== 'production',
}
