import { create } from 'zustand'
import type { TreeNode, ThemeInfo } from './api/client'

export interface OnlineUser {
  name: string
  color: string
  clientId: number
}

/** 协作者头像配色（按用户名哈希取色，各端一致） */
const PALETTE = [
  '#e11d48',
  '#2563eb',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
]

export function userColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length] ?? '#2563eb'
}

export type DocStatus = 'connecting' | 'synced' | 'error'

/** 文档加载进度（真实数据：WebSocket 实际接收字节 / 文档数据总量） */
export interface DocProgress {
  phase: 'idle' | 'connecting' | 'syncing' | 'rendering' | 'ready'
  /** 已接收字节（服务端下发的协同数据累计） */
  received: number
  /** 文档数据总量（docsize 接口） */
  total: number
}

export interface OutlineItem {
  level: number
  text: string
  /** 顶层标题序号（大纲按序跳转） */
  index: number
}

interface AppState {
  user: string | null
  tree: TreeNode[]
  currentPath: string | null
  themes: ThemeInfo[]
  theme: string
  onlineUsers: OnlineUser[]
  docStatus: DocStatus
  /** 上次同步完成时刻（ms）；setDocStatus('synced') 且此前非 synced 时记录 */
  lastSyncAt: number | null
  outline: OutlineItem[]
  docProgress: DocProgress
  setUser: (u: string | null) => void
  setTree: (t: TreeNode[]) => void
  setCurrentPath: (p: string | null) => void
  setThemes: (t: ThemeInfo[]) => void
  setTheme: (name: string) => void
  setOnlineUsers: (users: OnlineUser[]) => void
  setDocStatus: (s: DocStatus) => void
  setOutline: (items: OutlineItem[]) => void
  setDocProgress: (p: Partial<DocProgress>) => void
  resetDocProgress: () => void
}

function applyTheme(theme: string): void {
  localStorage.setItem('mf-theme', theme)
  let link = document.getElementById('mf-theme-css') as HTMLLinkElement | null
  if (theme === '') {
    link?.remove()
    return
  }
  if (!link) {
    link = document.createElement('link')
    link.id = 'mf-theme-css'
    link.rel = 'stylesheet'
    document.head.appendChild(link)
  }
  link.href = `/api/themes/${encodeURIComponent(theme)}.css`
}

export const useApp = create<AppState>((set) => ({
  user: null,
  tree: [],
  currentPath: null,
  themes: [],
  theme: localStorage.getItem('mf-theme') ?? 'markflow-paper',
  onlineUsers: [],
  docStatus: 'connecting',
  lastSyncAt: null,
  outline: [],
  docProgress: { phase: 'idle', received: 0, total: 0 },
  setUser: (user) => set({ user }),
  setTree: (tree) => set({ tree }),
  setCurrentPath: (currentPath) =>
    set({ currentPath, docStatus: 'connecting', onlineUsers: [], docProgress: { phase: 'connecting', received: 0, total: 0 } }),
  setThemes: (themes) => set({ themes }),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  },
  setOnlineUsers: (onlineUsers) => set({ onlineUsers }),
  setDocStatus: (docStatus) =>
    set((s) => ({
      docStatus,
      ...(docStatus === 'synced' && s.docStatus !== 'synced' ? { lastSyncAt: Date.now() } : {}),
    })),
  setOutline: (outline) => set({ outline }),
  setDocProgress: (p) => set((s) => ({ docProgress: { ...s.docProgress, ...p } })),
  resetDocProgress: () => set({ docProgress: { phase: 'idle', received: 0, total: 0 } }),
}))

// 启动时立即应用本地记忆的主题，避免闪烁
applyTheme(localStorage.getItem('mf-theme') ?? 'markflow-paper')
