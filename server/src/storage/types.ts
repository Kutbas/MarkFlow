export interface TreeNode {
  name: string
  /** POSIX 风格相对路径（相对笔记根） */
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

/**
 * 存储适配器：文件树 CRUD + 协同文档的加载/落盘。
 * - FsAdapter：磁盘纯 .md（STORAGE=fs，默认）
 * - PgAdapter：PostgreSQL，Yjs 二进制为权威状态（STORAGE=postgres）
 * 协同/CRDT/前端层完全无感。
 */
export interface StorageAdapter {
  readonly kind: 'fs' | 'postgres'

  /** 文件树 */
  readTree(): Promise<TreeNode[]>
  /** 读取单篇渲染 Markdown（预览/导出） */
  readMarkdown(relPath: string): Promise<string>
  /** 文件/文件夹 CRUD（路径已由上层校验） */
  createFile(relPath: string, initialMd: string): Promise<void>
  createFolder(relPath: string): Promise<void>
  rename(fromRel: string, toRel: string): Promise<void>
  move(fromRel: string, toRel: string): Promise<void>
  remove(relPath: string): Promise<void>
  exists(relPath: string): Promise<boolean>
  /** 是否为目录（move 目标校验） */
  isFolder(relPath: string): Promise<boolean>

  /**
   * 加载协同文档：优先返回 Yjs 二进制状态（保留 CRDT 身份），
   * 无状态时返回 null（上层按 Markdown 播种）。
   */
  loadYjsState(relPath: string): Promise<Uint8Array | null>
  /** 保存权威状态（Yjs 二进制 + 渲染 md 缓存），upsert 语义 */
  saveYjsState(relPath: string, update: Uint8Array, mdText: string): Promise<void>
  /** 清除协同状态（文件删除/重命名时） */
  clearYjsState(relPath: string): Promise<void>
}
