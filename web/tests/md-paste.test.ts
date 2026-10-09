import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown } from '../src/components/md-paste'

describe('looksLikeMarkdown 粘贴启发式', () => {
  it('识别常见 markdown 语法', () => {
    const cases = [
      '# 标题',
      '## 二级标题\n\n正文',
      '这是**加粗**文本',
      '__下划线加粗__',
      '- 无序列表\n- 第二项',
      '* 星号列表',
      '1. 有序列表\n2. 第二项',
      '> 引用块内容',
      '```\ncode\n```',
      '| a | b |\n| - | - |',
      '---\n分隔线之后的内容',
      '$$\nE=mc^2\n$$',
      '![图片](https://a.com/1.png)',
      '[链接](https://a.com)',
      '行内 `code` 标记',
    ]
    for (const c of cases) expect(looksLikeMarkdown(c), c).toBe(true)
  })

  it('普通文本不误伤', () => {
    const cases = [
      '今天天气不错，出去走走。',
      '会议记录：2026-10-08 下午三点，出席人员名单见附件。',
      '联系电话 138-0013-8000，微信同号。',
      'The quick brown fox jumps over the lazy dog.',
      '价格是 3.5 元，总计 100 元。',
      '',
      '   ',
    ]
    for (const c of cases) expect(looksLikeMarkdown(c), c).toBe(false)
  })
})
