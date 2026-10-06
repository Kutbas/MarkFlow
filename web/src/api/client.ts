export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: TreeNode[]
}

export interface ThemeInfo {
  name: string
  file: string
  url: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new Event('mf:unauthorized'))
    }
    throw new ApiError(String(data['error'] ?? res.statusText), res.status)
  }
  return data as T
}

export const api = {
  me: () => request<{ user: string | null }>('GET', '/api/auth/me'),
  login: (name: string, password: string) =>
    request<{ user: string }>('POST', '/api/auth/login', { name, password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout'),
  tree: () => request<{ tree: TreeNode[] }>('GET', '/api/files/tree'),
  createFile: (parentDir: string, name: string) =>
    request<{ path: string }>('POST', '/api/files', { parentDir, name, type: 'file' }),
  createFolder: (parentDir: string, name: string) =>
    request<{ path: string }>('POST', '/api/files', { parentDir, name, type: 'folder' }),
  rename: (path: string, newName: string) =>
    request<{ path: string }>('POST', '/api/files/rename', { path, newName }),
  move: (path: string, newParentDir: string) =>
    request<{ path: string }>('POST', '/api/files/move', { path, newParentDir }),
  remove: (path: string) =>
    request<{ ok: boolean }>('POST', '/api/files/delete', { path }),
  themes: () => request<{ themes: ThemeInfo[] }>('GET', '/api/themes'),
}
