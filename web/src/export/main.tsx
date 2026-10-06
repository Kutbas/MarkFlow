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

document.title = (path.split('/').pop() ?? 'MarkFlow') + ' — PDF 导出'

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

  // 等待异步渲染（Mermaid/MathJax）与字体全部就绪
  const started = Date.now()
  const waitReady = () => {
    const pendingMermaid = [...document.querySelectorAll('.mf-code .mf-render')].some((el) =>
      el.textContent?.includes('图表生成中'),
    )
    if (!pendingMermaid && document.fonts.status === 'loaded') {
      ;(window as unknown as { __mfReady: boolean }).__mfReady = true
      return
    }
    if (Date.now() - started > 15_000) {
      // 超时兜底：照常导出（图表缺失可接受）
      ;(window as unknown as { __mfReady: boolean }).__mfReady = true
      return
    }
    setTimeout(waitReady, 120)
  }
  document.fonts.ready.then(() => {}).catch(() => {})
  waitReady()
}

void main()
