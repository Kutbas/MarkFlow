/** 粘贴本地图片：拦截剪贴板图片 → 上传 → 插入 image 节点 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../src/api/client', () => ({
  api: {
    uploadImage: vi.fn(async (_blob: Blob) => ({ url: '/api/images/abc-123.png' })),
  },
  ApiError: class extends Error {},
}))

import { mdPastePlugin } from '../src/components/md-paste'
import { api } from '../src/api/client'

function fakeView() {
  const inserted: unknown[] = []
  const tr = {
    replaceSelectionWith: (node: unknown) => {
      inserted.push(node)
      return tr
    },
  }
  return {
    inserted,
    dispatch: vi.fn(),
    state: {
      schema: { nodes: { image: { create: (attrs: Record<string, string>) => ({ attrs }) } } },
      tr,
    },
  } as never
}

const handlePaste = (mdPastePlugin.props as { handlePaste: (view: never, event: ClipboardEvent) => boolean }).handlePaste

function pasteEvent(opts: { files?: File[]; markdown?: string; text?: string }): ClipboardEvent {
  return {
    clipboardData: {
      files: opts.files ?? [],
      getData: (type: string) =>
        type === 'text/markdown' ? (opts.markdown ?? '') : (opts.text ?? ''),
    },
  } as unknown as ClipboardEvent
}

beforeEach(() => {
  vi.mocked(api.uploadImage).mockClear()
})

describe('粘贴本地图片', () => {
  it('剪贴板有图片文件 → 拦截并异步插入 image 节点', async () => {
    const view = fakeView()
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const handled = handlePaste(view, pasteEvent({ files: [file], text: '' }))
    expect(handled).toBe(true)
    // 上传与插入是异步的
    await vi.waitFor(() => expect(view.dispatch).toHaveBeenCalled())
    expect(api.uploadImage).toHaveBeenCalledWith(file)
    expect(view.inserted[0]).toEqual({ attrs: { src: '/api/images/abc-123.png', alt: '' } })
  })

  it('内部复制（带 text/markdown）优先走 Milkdown 管线，不重新上传', async () => {
    const view = fakeView()
    const file = new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })
    const handled = handlePaste(view, pasteEvent({ files: [file], markdown: '![](a.png)' }))
    expect(handled).toBe(false)
    expect(api.uploadImage).not.toHaveBeenCalled()
  })

  it('纯文本粘贴不受影响（无图片文件走 markdown 启发式）', () => {
    const view = fakeView()
    const handled = handlePaste(view, pasteEvent({ text: '今天天气不错。' }))
    expect(handled).toBe(false)
    expect(api.uploadImage).not.toHaveBeenCalled()
  })
})
