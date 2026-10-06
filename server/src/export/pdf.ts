import puppeteer, { type Browser } from 'puppeteer'
import { config } from '../config.js'
import { safeJoin } from '../files/paths.js'

/** 导出页来源：生产模式为本服务托管的 /export.html，开发模式可指向 Vite */
function exportPageOrigin(): string {
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
  // 路径守卫 + 存在性校验（此处只需校验，不再读取内容——由导出页拉取）
  safeJoin(config.notesDir, relPath, { mustExist: true, mustBeMd: true })

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

    const exportDate = new Date().toISOString().slice(0, 10)
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="width:100%;padding:0 14mm;font-size:8px;color:#8a94a6;
                    font-family:-apple-system,Helvetica,sans-serif;">
          <span style="float:right;">MarkFlow</span>
        </div>`,
      footerTemplate: `
        <div style="width:100%;padding:0 14mm;font-size:8px;color:#8a94a6;
                    font-family:-apple-system,Helvetica,sans-serif;">
          <span style="float:left;">${exportDate}</span>
          <span style="float:right;">
            <span class="pageNumber"></span> / <span class="totalPages"></span>
          </span>
        </div>`,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    })
    return new Uint8Array(pdf)
  } finally {
    await page.close().catch(() => {})
  }
}
