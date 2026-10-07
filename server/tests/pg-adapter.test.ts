/**
 * PgAdapter 集成测试：@electric-sql/pglite（Node 内嵌真 PostgreSQL，无外部服务）。
 * 覆盖文件树 CRUD、Yjs 状态存取、重命名子孙迁移、级联删除。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { PgAdapter } from '../src/storage/pg-adapter.js'

// pglite 的 Pool 兼容层：query/connect/release
class PglitePoolShim {
  constructor(private readonly db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) {}
  async query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }> {
    const res = (await this.db.query(sql, params)) as unknown as {
      rows?: any[]
      affectedRows?: number
    }
    // pglite 的写语句返回 affectedRows（等同 pg rowCount）；读语句忽略
    return {
      rows: res.rows ?? [],
      rowCount: typeof res.affectedRows === 'number' ? res.affectedRows : undefined,
    }
  }
  async connect() {
    const self = this
    // 极简 client：事务走同一连接（pglite 单连接天然串行）
    let depth = 0
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (/^BEGIN/i.test(sql.trim())) depth++
        if (/^COMMIT/i.test(sql.trim()) || /^ROLLBACK/i.test(sql.trim())) depth--
        return self.query(sql, params)
      },
      release: () => {},
    } as never
  }
}

let adapter: PgAdapter
let cleanupDb: (() => Promise<void>) | null = null

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = await PGlite.create()
  cleanupDb = () => db.close()
  const shim = new PglitePoolShim(db as never)
  adapter = new PgAdapter(shim as never)
  await adapter.init()
})

afterAll(async () => {
  await cleanupDb?.()
})

describe('PgAdapter 文件树与状态', () => {
  it('创建文件/文件夹 → 树结构与排序', async () => {
    await adapter.createFolder('项目')
    await adapter.createFile('项目/笔记.md', '# 笔记\n')
    await adapter.createFile('甲.md', '# 甲\n')
    const tree = await adapter.readTree()
    expect(tree.map((n) => n.path)).toEqual(['项目', '甲.md'])
    expect(tree[0]!.children).toEqual([
      { name: '笔记.md', path: '项目/笔记.md', type: 'file' },
    ])
  })

  it('重复创建 → EXISTS / 不存在 → NOT_FOUND', async () => {
    await expect(adapter.createFile('甲.md', 'x')).rejects.toThrow('EXISTS')
    await expect(adapter.createFolder('项目')).rejects.toThrow('EXISTS')
    await expect(adapter.readMarkdown('幽灵.md')).rejects.toThrow('NOT_FOUND')
    await expect(adapter.rename('幽灵.md', 'x.md')).rejects.toThrow('NOT_FOUND')
  })

  it('Yjs 状态：保存→加载 roundtrip 保留 CRDT 身份', async () => {
    const ydoc = new Y.Doc()
    ydoc.getXmlFragment('prosemirror').insert(0, [
      Object.assign(new Y.XmlElement('paragraph'), {}),
    ])
    const ytext = new Y.XmlText('PG 状态测试')
    ;(ydoc.getXmlFragment('prosemirror').toArray()[0] as Y.XmlElement).insert(0, [ytext])
    const update = Y.encodeStateAsUpdate(ydoc)

    await adapter.saveYjsState('甲.md', update, '# 甲\\n\\nPG 状态测试\\n')
    const loaded = await adapter.loadYjsState('甲.md')
    expect(loaded).not.toBeNull()
    const restored = new Y.Doc()
    Y.applyUpdate(restored, loaded!)
    expect(restored.getXmlFragment('prosemirror').toString()).toContain('PG 状态测试')
    // md 缓存
    expect(await adapter.readMarkdown('甲.md')).toContain('PG 状态测试')
  })

  it('重命名目录：子孙路径整体迁移，状态随行', async () => {
    await adapter.createFolder('旧名')
    await adapter.createFile('旧名/子文档.md', '# 子')
    await adapter.saveYjsState(
      '旧名/子文档.md',
      Y.encodeStateAsUpdate(new Y.Doc()),
      '# 子 v1',
    )
    await adapter.rename('旧名', '新名')
    expect(await adapter.exists('旧名')).toBe(false)
    expect(await adapter.exists('新名/子文档.md')).toBe(true)
    expect(await adapter.readMarkdown('新名/子文档.md')).toBe('# 子 v1')
  })

  it('move 到另一目录', async () => {
    await adapter.createFolder('目标目录')
    await adapter.move('甲.md', '目标目录/甲.md')
    expect(await adapter.exists('目标目录/甲.md')).toBe(true)
    expect(await adapter.exists('甲.md')).toBe(false)
  })

  it('删除目录级联清状态与子孙', async () => {
    await adapter.remove('新名')
    expect(await adapter.exists('新名/子文档.md')).toBe(false)
    await expect(adapter.readMarkdown('新名/子文档.md')).rejects.toThrow('NOT_FOUND')
    await expect(adapter.remove('不存在的.md')).rejects.toThrow('NOT_FOUND')
  })

  it('isFolder / exists / clearYjsState', async () => {
    expect(await adapter.isFolder('目标目录')).toBe(true)
    expect(await adapter.isFolder('目标目录/甲.md')).toBe(false)
    expect(await adapter.exists('目标目录/甲.md')).toBe(true)
    await adapter.clearYjsState('目标目录/甲.md')
    expect(await adapter.loadYjsState('目标目录/甲.md')).toBeNull()
  })

  it('深层目录自动创建父级', async () => {
    await adapter.createFile('深层/目录/文件.md', '# 深')
    expect(await adapter.exists('深层')).toBe(true)
    expect(await adapter.exists('深层/目录')).toBe(true)
    const tree = await adapter.readTree()
    const deep = tree.find((n) => n.path === '深层')
    expect(deep?.children?.[0]?.path).toBe('深层/目录')
  })
})

describe('特殊字符路径（LIKE 转义回调）', () => {
  it('含 % 与 _ 的文件名可 rename/remove', async () => {
    await adapter.createFile('100%进度_表.md', '# x').catch(() => {})
    await adapter.createFolder('目录_甲').catch(() => {})
    await adapter.createFile('目录_甲/子%文档.md', '# y').catch(() => {})
    await adapter.rename('目录_甲', '目录_乙')
    expect(await adapter.exists('目录_乙/子%文档.md')).toBe(true)
    await adapter.remove('目录_乙') // 目录 LIKE 前缀删除
    expect(await adapter.exists('目录_乙/子%文档.md')).toBe(false)
  })
})

describe('事务回滚', () => {
  it('rename 事务失败时 ROLLBACK 且不产生部分更新', async () => {
    await adapter.createFile('回滚.md', '# r').catch(() => {})
    const pool = (adapter as unknown as { pool: { query: (s: string, p?: unknown[]) => Promise<unknown> } }).pool
    const original = pool.query.bind(pool)
    pool.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE files')) throw new Error('注入失败')
      return original(sql, params)
    }) as typeof pool.query
    await expect(adapter.rename('回滚.md', '回滚2.md')).rejects.toThrow('注入失败')
    pool.query = original
    expect(await adapter.exists('回滚.md')).toBe(true)
  })
})
