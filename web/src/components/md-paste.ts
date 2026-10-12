/**
 * Markdown 粘贴识别：从外部（网页/编辑器/聊天工具）复制的纯文本
 * 若带 markdown 语法特征，直接解析渲染，而不是当普通文本逐字插入。
 * 富文本（text/html）粘贴不拦截，走 ProseMirror 默认解析。
 */
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Slice } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { getPMParser } from './pm-view'
import { api } from '../api/client'
import { liftQuotedMath, normalizeBlockMath } from '@markflow/shared/math'

/** 上传粘贴的本地图片，逐张插入光标处（异步完成后 dispatch） */
export async function insertPastedImages(view: EditorView, files: File[]): Promise<void> {
  for (const file of files) {
    try {
      const { url } = await api.uploadImage(file)
      const imageType = view.state.schema.nodes['image']
      if (!imageType) continue
      view.dispatch(view.state.tr.replaceSelectionWith(imageType.create({ src: url, alt: '' })))
    } catch (e) {
      console.warn('[MarkFlow] 图片上传失败：', e)
    }
  }
}

const MD_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/m, // 标题
  /(\*\*|__).+?\1/, // 加粗
  /^\s*[-*+]\s+\S/m, // 无序列表
  /^\s*\d+[.)]\s+\S/m, // 有序列表
  /^>\s?\S/m, // 引用
  /^```/m, // 围栏代码块
  /^\|.*\|/m, // 表格行
  /^\s*[-*_]{3,}\s*$/m, // 分隔线
  /\$\$[\s\S]+?\$\$/, // 块公式
  /!\[[^\]]*\]\([^)]+\)/, // 图片
  /\[[^\]]+\]\([^)]+\)/, // 链接
  /`[^`\n]+`/, // 行内代码
]

/** 启发式判断纯文本是否像 markdown（命中任一特征即认定）。
 *  普通中文/英文句子不会误伤：日期 2024-10-08 不满足"- +空格"、# 需行首+空格。 */
export function looksLikeMarkdown(text: string): boolean {
  return MD_PATTERNS.some((p) => p.test(text))
}

export const mdPasteKey = new PluginKey('mf-md-paste')

export const mdPastePlugin = new Plugin({
  key: mdPasteKey,
  props: {
    handlePaste(view, event) {
      const cd = event.clipboardData
      if (!cd) return false
      // Milkdown 内部复制自带 text/markdown，优先交由其自身管线
      //（编辑器内复制的图片节点也走这里，避免被下面的上传分支误重新上传）
      if (cd.getData('text/markdown')) return false
      // 本地图片（截图等）：上传后插入。handlePaste 需同步返回布尔，
      // 上传异步完成后自行 dispatch 插入
      const imageFiles = [...(cd.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (imageFiles.length > 0) {
        void insertPastedImages(view, imageFiles)
        return true
      }
      const text = cd.getData('text/plain')
      if (!text.trim() || !looksLikeMarkdown(text)) return false
      const parse = getPMParser() as ((md: string) => PMNode) | null
      if (!parse) return false

      try {
        // 与服务端播种同规则：引用块内公式提升 + 块公式定界符规范化
        const doc = parse(normalizeBlockMath(liftQuotedMath(text)))
        // 空段落兜底：解析结果只有空 paragraph 时按纯文本处理
        if (doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild?.content.size === 0)) {
          return false
        }
        view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)))
        return true
      } catch {
        return false // 解析异常回落默认粘贴
      }
    },
  },
})
