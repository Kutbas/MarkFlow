import type { PoolClient } from 'pg'
import type { StorageAdapter } from './types.js'
import type { TreeNode } from './types.js'

/**
 * PostgreSQL 适配器：
 * - files 表：文件树（重命名/移动事务化）
 * - doc_state 表：Yjs 二进制权威状态 + md 渲染缓存
 * - revisions 表：每次落盘留档（本期只写，为回滚铺路）
 * 依赖注入 Pool（测试传 pglite 的，生产传 pg 的）。
 */
export class PgAdapter implements StorageAdapter {
  readonly kind = 'postgres' as const

  constructor(
    private readonly pool: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>
      connect: () => Promise<PoolClient>
    },
  ) {}

  private async queryRows<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.pool.query(sql, params)
    return rows as T[]
  }

  async init(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS files (
        path text PRIMARY KEY,
        type text NOT NULL CHECK (type IN ('file','dir')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS doc_state (
        path text PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE ON UPDATE CASCADE,
        yjs_update bytea NOT NULL,
        md_text text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS revisions (
        id bigserial PRIMARY KEY,
        path text NOT NULL,
        yjs_update bytea NOT NULL,
        md_text text NOT NULL,
        saved_at timestamptz NOT NULL DEFAULT now()
      )`,
    ]
    // pg 不支持单条多语句 prepared statement；逐条执行（pglite 亦然）
    for (const sql of statements) {
      await this.pool.query(sql)
    }
  }

  async readTree(): Promise<TreeNode[]> {
    const rows = await this.queryRows<{ path: string; type: string }>(
      'SELECT path, type FROM files ORDER BY path',
    )
    const root: TreeNode[] = []
    const dirIndex = new Map<string, TreeNode>()
    // 先建目录，再挂子节点（SQL 按 path 排序保证父先于子）
    for (const row of rows) {
      const segs = row.path.split('/')
      const name = segs[segs.length - 1] ?? row.path
      const parentPath = segs.slice(0, -1).join('/')
      const node: TreeNode = { name, path: row.path, type: row.type === 'dir' ? 'dir' : 'file' }
      if (node.type === 'dir') {
        node.children = []
        dirIndex.set(row.path, node)
      }
      const parent = parentPath ? dirIndex.get(parentPath) : undefined
      if (parent) parent.children!.push(node)
      else root.push(node)
    }
    // 目录在前、文件在后，中文排序（与 FsAdapter 行为一致）
    const zh = new Intl.Collator('zh-Hans-CN', { numeric: true })
    const sortRec = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return zh.compare(a.name, b.name)
      })
      for (const n of nodes) if (n.children) sortRec(n.children)
    }
    sortRec(root)
    return root
  }

  async readMarkdown(relPath: string): Promise<string> {
    const rows = await this.queryRows<{ md_text: string }>(
      'SELECT md_text FROM doc_state WHERE path = $1',
      [relPath],
    )
    const first = rows[0]
    if (first) return first.md_text
    const f = await this.queryRows<{ type: string }>('SELECT type FROM files WHERE path = $1', [
      relPath,
    ])
    if (f.length === 0) throw new Error('NOT_FOUND')
    return ''
  }

  async createFile(relPath: string, initialMd: string): Promise<void> {
    await this.ensureParentDirs(relPath)
    const { rowCount } = await this.pool.query(
      "INSERT INTO files (path, type) VALUES ($1, 'file') ON CONFLICT DO NOTHING",
      [relPath],
    )
    if (!rowCount) throw new Error('EXISTS')
    await this.pool.query(
      'INSERT INTO doc_state (path, yjs_update, md_text) VALUES ($1, $2, $3) ON CONFLICT (path) DO NOTHING',
      [relPath, Buffer.from(new Uint8Array([0])), initialMd],
    )
  }

  async createFolder(relPath: string): Promise<void> {
    await this.ensureParentDirs(relPath)
    const { rowCount } = await this.pool.query(
      "INSERT INTO files (path, type) VALUES ($1, 'dir') ON CONFLICT DO NOTHING",
      [relPath],
    )
    if (!rowCount) throw new Error('EXISTS')
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.withTransaction(async (client) => {
      // 重命名自身 + 所有子孙路径前缀
      const like = fromRel.replace(/[%_\\]/g, (c) => '\\' + c) + '/%'
      const res = await client.query(
        `UPDATE files SET path = $1 || substring(path from ${fromRel.length + 1}), updated_at = now()
         WHERE path = $2 OR path LIKE $3 ESCAPE '\\'`,
        [toRel, fromRel, like],
      )
      if (res.rowCount === 0) throw new Error('NOT_FOUND')
      // doc_state.path 由外键 ON UPDATE CASCADE 自动随行
      await this.ensureParentDirsTx(client, toRel)
    })
  }

  async move(fromRel: string, toRel: string): Promise<void> {
    await this.rename(fromRel, toRel)
  }

  async remove(relPath: string): Promise<void> {
    const like = relPath.replace(/[%_\\]/g, (c) => '\\' + c) + '/%'
    const { rowCount } = await this.pool.query(
      `DELETE FROM files WHERE path = $1 OR path LIKE $2 ESCAPE '\\'`,
      [relPath, like],
    )
    if (rowCount === 0) throw new Error('NOT_FOUND')
    // doc_state 级联删除（FK）
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.queryRows('SELECT 1 AS x FROM files WHERE path = $1', [relPath])).length > 0
  }

  async isFolder(relPath: string): Promise<boolean> {
    const rows = await this.queryRows<{ type: string }>(
      "SELECT type FROM files WHERE path = $1 AND type = 'dir'",
      [relPath],
    )
    return rows.length > 0
  }

  async loadYjsState(relPath: string): Promise<Uint8Array | null> {
    const rows = await this.queryRows<{ yjs_update: Buffer }>(
      'SELECT yjs_update FROM doc_state WHERE path = $1',
      [relPath],
    )
    if (rows.length === 0) return null
    const buf = rows[0]!.yjs_update
    // 空占位状态视为无状态
    if (!buf || buf.length <= 1) return null
    return new Uint8Array(buf)
  }

  async saveYjsState(relPath: string, update: Uint8Array, mdText: string): Promise<void> {
    const buf = Buffer.from(update)
    await this.pool.query(
      `INSERT INTO doc_state (path, yjs_update, md_text, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (path) DO UPDATE SET yjs_update = $2, md_text = $3, updated_at = now()`,
      [relPath, buf, mdText],
    )
    await this.pool.query(
      'INSERT INTO revisions (path, yjs_update, md_text) VALUES ($1, $2, $3)',
      [relPath, buf, mdText],
    )
  }

  async clearYjsState(relPath: string): Promise<void> {
    await this.pool.query('DELETE FROM doc_state WHERE path = $1', [relPath])
  }

  private async ensureParentDirs(relPath: string): Promise<void> {
    await this.withTransaction((client) => this.ensureParentDirsTx(client, relPath))
  }

  private async ensureParentDirsTx(client: PoolClient, relPath: string): Promise<void> {
    const segs = relPath.split('/')
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/')
      await client.query(
        "INSERT INTO files (path, type) VALUES ($1, 'dir') ON CONFLICT DO NOTHING",
        [dir],
      )
    }
  }

  private async withTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await (this.pool as unknown as {
      connect: () => Promise<PoolClient>
    }).connect()
    try {
      await client.query('BEGIN')
      await fn(client)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}
