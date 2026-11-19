/**
 * 有序项下被压平的无序项恢复嵌套：外部复制到剪贴板的 markdown 常丢失
 * 行首缩进，`1. 项` 后紧跟行首 `* 项`（无空行间隔）在严格 CommonMark 下
 * 是两个平级兄弟列表——层级信息在复制时已被剥掉，解析器无从恢复。
 * Typora 对这种相邻标记做嵌套渲染（宽松行为），用户预期与之对齐。
 *
 * 粘贴/导入前把紧跟有序项的无序项行缩进到该有序项的内容列（标记宽 +
 * 后随空格数，至少 1），后续连续无序项同宽跟随。保守边界：空行、其他
 * 非空行或下一个行首有序项即终止续行；已有缩进、无序项打头的内容一律
 * 不动——只修"有序项 → 无缩进无序项直接相邻"这一种指纹。
 */
const ORDERED_RE = /^(\d{1,9}[.)])(\s|$)/
const BULLET_RE = /^([*+-])(\s|$)/
/** `- - -` / `***` 一类主题分割线：首字符是列表标记但不是列表项 */
const THEMATIC_RE = /^([-*_])( *\1){2,} *$/

/** 行首有序项的内容列：标记字符数 + 后随空格数（至少按 1 计） */
function orderedContentCol(line: string): number {
  const m = /^(\d{1,9}[.)])( *)/.exec(line)
  const marker = m?.[1]
  if (!marker) return 3
  return marker.length + Math.max(m?.[2]?.length ?? 0, 1)
}

export function nestBulletsUnderOrdered(md: string): string {
  // prev = 续行列：上一行是行首有序项（其内容列）或已嵌套的无序项（缩进列）
  let prev: number | null = null
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*$/.test(line)) {
        prev = null // 空行终止续行
        return line
      }
      if (!THEMATIC_RE.test(line) && BULLET_RE.test(line)) {
        if (prev !== null) return ' '.repeat(prev) + line // 嵌套并保持续行态
        return line // 平级 bullet 不触发后续嵌套
      }
      if (ORDERED_RE.test(line)) {
        prev = orderedContentCol(line)
        return line
      }
      prev = null // 其他非空行终止续行
      return line
    })
    .join('\n')
}
