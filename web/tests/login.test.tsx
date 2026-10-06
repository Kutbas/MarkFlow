import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Login } from '../src/components/Login'

describe('Login 组件', () => {
  afterEach(() => cleanup())
  it('空输入时登录按钮禁用', () => {
    render(<Login onLogin={() => {}} />)
    const btn = screen.getByRole('button', { name: '登录' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('提交凭据成功后回调 onLogin', async () => {
    const onLogin = vi.fn()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: 'admin' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<Login onLogin={onLogin} />)

    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'admin123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith('admin'))
    vi.unstubAllGlobals()
  })

  it('登录失败展示错误信息', async () => {
    const onLogin = vi.fn()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: '用户名或密码错误' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<Login onLogin={onLogin} />)

    fireEvent.change(screen.getByPlaceholderText('用户名'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByPlaceholderText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(screen.getByText('用户名或密码错误')).toBeTruthy())
    expect(onLogin).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
