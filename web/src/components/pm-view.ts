/** PM EditorView / parser / serializer 全局存取（MilkdownEditor 初始化后写入，工具栏等 UI 组件读取） */
let view: unknown = null
let parser: ((markdown: string) => unknown) | null = null
let serializer: ((doc: unknown) => string) | null = null

export function setPMView(v: unknown): void {
  view = v
  // 调试：暴露到 window 供浏览器控制台诊断（生产无碍，只是引用）
  if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__mfPMView = v
}

export function getPMView(): unknown {
  return view
}

/** 编辑器同 schema 实例的 markdown parser——源码编辑回填必须用它，
 *  shared/headless 的节点属于另一套 schema，直接 replaceWith 会被协同同步丢弃 */
export function setPMParser(p: unknown): void {
  parser = p as (markdown: string) => unknown
}

export function getPMParser(): ((markdown: string) => unknown) | null {
  return parser
}

/** 编辑器同 schema 的 markdown serializer——整跨源码展开（span 区字面）
 *  需要把区域内容序列化成 markdown 源码，必须用它保证 schema 一致 */
export function setPMSerializer(s: (doc: unknown) => string): void {
  serializer = s
}

export function getPMSerializer(): ((doc: unknown) => string) | null {
  return serializer
}
