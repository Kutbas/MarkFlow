import { beforeEach, describe, expect, it } from 'vitest'
import { useApp, userColor } from '../src/store'

describe('store：主题应用', () => {
  beforeEach(() => {
    localStorage.clear()
    document.getElementById('mf-theme-css')?.remove()
  })

  it('setTheme 注入 <link> 并持久化到 localStorage', () => {
    useApp.getState().setTheme('latex')
    const link = document.getElementById('mf-theme-css') as HTMLLinkElement | null
    expect(link).toBeTruthy()
    expect(link!.href).toContain('/api/themes/latex.css')
    expect(localStorage.getItem('mf-theme')).toBe('latex')
  })

  it('切换主题复用同一个 link 节点', () => {
    useApp.getState().setTheme('markflow-paper')
    useApp.getState().setTheme('markflow-night')
    const links = document.querySelectorAll('#mf-theme-css')
    expect(links.length).toBe(1)
    expect((links[0] as HTMLLinkElement).href).toContain('markflow-night')
  })

  it('空主题名移除 link', () => {
    useApp.getState().setTheme('x')
    useApp.getState().setTheme('')
    expect(document.getElementById('mf-theme-css')).toBeNull()
  })
})

describe('store：文档切换与状态重置', () => {
  it('setCurrentPath 重置协同状态', () => {
    useApp.setState({ onlineUsers: [{ name: 'a', color: '#000', clientId: 1 }], docStatus: 'synced' })
    useApp.getState().setCurrentPath('x.md')
    const s = useApp.getState()
    expect(s.currentPath).toBe('x.md')
    expect(s.docStatus).toBe('connecting')
    expect(s.onlineUsers).toEqual([])
  })
})

describe('userColor', () => {
  it('同名同色、不同名大概率异色', () => {
    expect(userColor('alice')).toBe(userColor('alice'))
    expect(userColor('alice')).toMatch(/^#[0-9a-f]{6}$/)
    const distinct = new Set(['alice', 'bob', 'carol', 'dave'].map(userColor))
    expect(distinct.size).toBeGreaterThan(1)
  })
})
