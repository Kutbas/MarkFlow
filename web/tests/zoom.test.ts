import { afterEach, describe, expect, it } from 'vitest'
import { getZoom, setZoom } from '../src/zoom'

afterEach(() => {
  setZoom(1)
})

describe('编辑区缩放', () => {
  it('setZoom 写 CSS 变量并持久化 localStorage', () => {
    setZoom(1.3)
    expect(getZoom()).toBe(1.3)
    expect(document.documentElement.style.getPropertyValue('--mf-zoom')).toBe('1.3')
    expect(localStorage.getItem('mf-editor-zoom')).toBe('1.3')
  })

  it('范围 clamp 到 0.6–2.0，步进取一位小数', () => {
    expect(setZoom(3)).toBe(2)
    expect(setZoom(0.1)).toBe(0.6)
    expect(setZoom(1.25)).toBe(1.3)
  })

  it('重置回 1', () => {
    setZoom(1.5)
    setZoom(1)
    expect(getZoom()).toBe(1)
  })
})
