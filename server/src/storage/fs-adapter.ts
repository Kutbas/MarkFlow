import fs from 'node:fs'
import path from 'node:path'
import type { StorageAdapter } from './types.js'
import type { TreeNode } from '../files/tree.js'
import { readTree } from '../files/tree.js'
import { atomicWrite } from '../util/atomicWrite.js'

/**
 * 磁盘适配器：现状实现的收编。
 * - 文件树/CRUD 直接操作 NOTES_DIR
 * - Yjs 状态存 .markflow-state/（隐藏目录，gitignore；服务私有缓存）
 *   有状态时重启可无损恢复 CRDT 身份，无则按磁盘 md 重新播种
 */
export class FsAdapter implements StorageAdapter {
  readonly kind = 'fs' as const

  constructor(
    private readonly notesDir: string,
    private readonly stateDir: string,
  ) {}

  private abs(relPath: string): string {
    return path.join(this.notesDir, ...relPath.split('/'))
  }

  private stateAbs(relPath: string): string {
    // 状态键转义：路径分隔符 → \u0001，避免嵌套目录
    return path.join(this.stateDir, encodeURIComponent(relPath) + '.yjs')
  }

  async readTree(): Promise<TreeNode[]> {
    return readTree(this.notesDir)
  }

  async readMarkdown(relPath: string): Promise<string> {
    return fs.readFileSync(this.abs(relPath), 'utf8')
  }

  async createFile(relPath: string, initialMd: string): Promise<void> {
    if (fs.existsSync(this.abs(relPath))) throw new Error('EXISTS')
    await atomicWrite(this.abs(relPath), initialMd)
  }

  async createFolder(relPath: string): Promise<void> {
    if (fs.existsSync(this.abs(relPath))) throw new Error('EXISTS')
    fs.mkdirSync(this.abs(relPath), { recursive: true })
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    fs.renameSync(this.abs(fromRel), this.abs(toRel))
    this.migrateState(fromRel, toRel)
  }

  async move(fromRel: string, toRel: string): Promise<void> {
    await this.rename(fromRel, toRel)
  }

  async remove(relPath: string): Promise<void> {
    fs.rmSync(this.abs(relPath), { recursive: true })
    // 目录删除时清理其下所有状态
    const prefix = relPath + '/'
    if (fs.existsSync(this.stateDir)) {
      for (const f of fs.readdirSync(this.stateDir)) {
        const key = decodeURIComponent(f.replace(/\.yjs$/, ''))
        if (key === relPath || key.startsWith(prefix)) {
          fs.rmSync(path.join(this.stateDir, f))
        }
      }
    }
  }

  async exists(relPath: string): Promise<boolean> {
    return fs.existsSync(this.abs(relPath))
  }

  async isFolder(relPath: string): Promise<boolean> {
    try {
      return fs.statSync(this.abs(relPath)).isDirectory()
    } catch {
      return false
    }
  }

  async loadYjsState(relPath: string): Promise<Uint8Array | null> {
    const p = this.stateAbs(relPath)
    if (!fs.existsSync(p)) return null
    return new Uint8Array(fs.readFileSync(p))
  }

  async saveYjsState(relPath: string, update: Uint8Array, mdText: string): Promise<void> {
    // fs 模式双写：磁盘 .md（人可直接用）+ Yjs 状态（CRDT 身份恢复）
    await atomicWrite(this.abs(relPath), mdText)
    fs.mkdirSync(this.stateDir, { recursive: true })
    fs.writeFileSync(this.stateAbs(relPath), update)
  }

  async clearYjsState(relPath: string): Promise<void> {
    const p = this.stateAbs(relPath)
    if (fs.existsSync(p)) fs.rmSync(p)
  }

  private migrateState(fromRel: string, toRel: string): void {
    const from = this.stateAbs(fromRel)
    if (!fs.existsSync(from)) return
    fs.renameSync(from, this.stateAbs(toRel))
  }
}
