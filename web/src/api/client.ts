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
  /** 上传本地图片（截图粘贴等）：原始二进制 body，Content-Type = 图片 MIME */
  uploadImage: async (blob: Blob): Promise<{ url: string }> => {
    const res = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      credentials: 'same-origin',
      body: blob,
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      if (res.status === 401) {
        window.dispatchEvent(new Event('mf:unauthorized'))
      }
      throw new ApiError(String(data['error'] ?? res.statusText), res.status)
    }
    return data as { url: string }
  },
  createFile: (parentDir: string, name: string, initialMd?: string) =>
    request<{ path: string }>('POST', '/api/files', {
      parentDir,
      name,
      type: 'file',
      ...(initialMd !== undefined ? { initialMd } : {}),
    }),
  createFolder: (parentDir: string, name: string) =>
    request<{ path: string }>('POST', '/api/files', { parentDir, name, type: 'folder' }),
  rename: (path: string, newName: string) =>
    request<{ path: string }>('POST', '/api/files/rename', { path, newName }),
  move: (path: string, newParentDir: string) =>
    request<{ path: string }>('POST', '/api/files/move', { path, newParentDir }),
  remove: (path: string) =>
    request<{ ok: boolean }>('POST', '/api/files/delete', { path }),
  themes: () => request<{ themes: ThemeInfo[] }>('GET', '/api/themes'),
  docSize: (path: string) =>
    request<{ path: string; size: number }>('GET', `/api/files/docsize?path=${encodeURIComponent(path)}`),
}
