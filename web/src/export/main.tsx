/**
 * PDF 导出专用只读渲染页（/export.html?path=...&theme=...）。
 * 与编辑器同一套 schema/视图（MathJax/Mermaid/hljs），保证所见即所得；
 * 渲染完成后置 window.__mfReady = true，供 Puppeteer 等待。
 */
import { Editor, defaultValueCtx, rootCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { codeBlockView, mathViews } from '../components/views'
import { markflowPreset } from '@markflow/shared'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '../styles/global.css'

// 标记导出上下文：打印 CSS 据此取消编辑器的满屏高度（否则 PDF 首页空白）
document.body.classList.add('mf-export')
// 删除模板残留的主应用挂载点（height:100% 会占满首屏把正文推到第 2 页）
document.getElementById('root')?.remove()

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? ''
const theme = params.get('theme') ?? localStorage.getItem('mf-theme') ?? 'markflow-paper'

// 主题 CSS 注入（与主应用一致的 <link> 方式）
if (theme) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `/api/themes/${encodeURIComponent(theme)}.css`
  document.head.appendChild(link)
}

// PDF 元数据 Title：纯文档名（去掉 .md 后缀，避免阅读器显示怪尾巴）
document.title = path.split('/').pop()?.replace(/\.md$/i, '') ?? 'MarkFlow'

async function main() {
  if (!path) {
    document.body.innerHTML = '<div style="padding:40px;color:#c00">缺少 path 参数</div>'
    return
  }
  const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`, {
    credentials: 'same-origin',
  })
  if (!res.ok) {
    document.body.innerHTML = `<div style="padding:40px;color:#c00">读取文档失败（${res.status}）</div>`
    return
  }
  const { content } = (await res.json()) as { content: string }
  const mount = document.createElement('div')
  mount.id = 'write'
  document.body.appendChild(mount)

  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, mount)
      ctx.set(defaultValueCtx, content)
      ctx.set(editorViewOptionsCtx, { editable: () => false, attributes: { spellcheck: 'false' } })
    })
    .use(commonmark)
    .use(gfm)
    .use(markflowPreset)
    .use(codeBlockView)
    .use(mathViews)

  await editor.create()

  // 等待异步渲染（Mermaid/MathJax）、字体与图片全部就绪——
  // 字体未就绪时排版用 fallback 度量，断行与页面不一致（大文档 Mermaid 串行
  // 渲染超 15s 时旧逻辑会提前放行）；超时提高到 60s，且超时放行前仍等字体
  const started = Date.now()
  const waitReady = () => {
    const pendingMermaid = [...document.querySelectorAll('.mf-code .mf-render')].some((el) =>
      el.textContent?.includes('图表生成中'),
    )
    const pendingImages = [...document.querySelectorAll('#write img')].some(
      (img) => !(img as HTMLImageElement).complete,
    )
    if (!pendingMermaid && !pendingImages && document.fonts.status === 'loaded') {
      ;(window as unknown as { __mfReady: boolean }).__mfReady = true
      return
    }
    if (Date.now() - started > 60_000) {
      // 超时兜底：Mermaid/图片缺失可接受，但字体必须等（断行一致性）
      document.fonts.ready.then(() => {
        ;(window as unknown as { __mfReady: boolean }).__mfReady = true
      })
      return
    }
    setTimeout(waitReady, 150)
  }
  waitReady()
}

void main()
