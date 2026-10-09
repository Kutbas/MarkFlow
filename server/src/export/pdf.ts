import puppeteer, { type Browser } from 'puppeteer'
import { getStorage } from '../storage/index.js'
import { config } from '../config.js'
import { validateRelPath } from '../files/paths.js'

/** 导出页来源：生产模式为本服务托管的 /export.html，开发模式可指向 Vite */
export function exportPageOrigin(): string {
  return process.env.EXPORT_ORIGIN?.replace(/\/$/, '') ?? `http://127.0.0.1:${config.port}`
}

let browserPromise: Promise<Browser> | null = null
async function getBrowser(): Promise<Browser> {
  browserPromise ??= puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  })
  return browserPromise
}

export async function renderPdf(
  relPath: string,
  theme: string | undefined,
  cookieToken: string,
): Promise<Uint8Array> {
  // 路径语法校验 + 存在性校验（内容由导出页经 API 拉取）
  validateRelPath(relPath, { mustBeMd: true })
  if (!(await (await getStorage()).exists(relPath))) {
    throw new Error('文件不存在')
  }

  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setCookie({
      name: 'mf_token',
      value: cookieToken,
      url: exportPageOrigin(),
    })
    const url = `${exportPageOrigin()}/export.html?path=${encodeURIComponent(relPath)}${
      theme ? `&theme=${encodeURIComponent(theme)}` : ''
    }`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // 等待渲染就绪标志（编辑器创建 + Mermaid/MathJax/字体完成）
    await page.waitForFunction(
      () => {
        return (globalThis as unknown as { __mfReady?: boolean }).__mfReady === true
      },
      { timeout: 40_000, polling: 200 },
    )

    // 双保险：PDF 生成前再等一次字体（断行一致性依赖 webfont 度量）
    await page.evaluate('document.fonts.ready')
    // 与主题 @media print 设计对齐（latex：#write padding 清零 + @page 边距）：
    // A4 210mm - 左右 2cm 边距 = 版心 170mm = 屏幕上 #write 减去自身 padding 后的
    // 行宽（643px），断行与页面逐字一致；上下边距用主题的 1.8/1.2cm
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      // 侧边栏大纲（书签）：由文档标题层级生成，支持阅读器内跳转
      outline: true,
      tagged: true,
      margin: { top: '1.8cm', bottom: '1.2cm', left: '2cm', right: '2cm' },
    })
    return new Uint8Array(pdf)
  } finally {
    await page.close().catch(() => {})
  }
}
