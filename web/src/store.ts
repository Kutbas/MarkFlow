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

export interface OutlineItem {
  level: number
  text: string
}

interface AppState {
  user: string | null
  tree: TreeNode[]
  currentPath: string | null
  themes: ThemeInfo[]
  theme: string
  onlineUsers: OnlineUser[]
  docStatus: DocStatus
  outline: OutlineItem[]
  setUser: (u: string | null) => void
  setTree: (t: TreeNode[]) => void
  setCurrentPath: (p: string | null) => void
  setThemes: (t: ThemeInfo[]) => void
  setTheme: (name: string) => void
  setOnlineUsers: (users: OnlineUser[]) => void
  setDocStatus: (s: DocStatus) => void
  setOutline: (items: OutlineItem[]) => void
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
  outline: [],
  setUser: (user) => set({ user }),
  setTree: (tree) => set({ tree }),
  setCurrentPath: (currentPath) =>
    set({ currentPath, docStatus: 'connecting', onlineUsers: [] }),
  setThemes: (themes) => set({ themes }),
  setTheme: (theme) => {
    applyTheme(theme)
    set({ theme })
  },
  setOnlineUsers: (onlineUsers) => set({ onlineUsers }),
  setDocStatus: (docStatus) => set({ docStatus }),
  setOutline: (outline) => set({ outline }),
}))

// 启动时立即应用本地记忆的主题，避免闪烁
applyTheme(localStorage.getItem('mf-theme') ?? 'markflow-paper')
