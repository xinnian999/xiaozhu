import { create } from 'zustand'

// ============================================
// UI store：跨组件的瞬时 UI 状态
// ============================================

export type WorkTab = 'preview' | 'code'

/** WebContainer 生命周期状态 */
export type WCStatus =
  | 'idle'        // 未启动
  | 'booting'     // 正在 boot WebContainer 实例
  | 'mounting'    // 正在写入文件树
  | 'installing'  // 正在 npm install
  | 'starting'    // 正在 npm run dev 等就绪
  | 'ready'       // 已 ready，url 可用
  | 'syncing'     // 增量同步文件中（切版本时）
  | 'error'

type UIState = {
  /** 当前激活的工作区 tab */
  workTab: WorkTab
  setWorkTab: (t: WorkTab) => void

  /** 左侧 Chat 是否折叠 */
  chatCollapsed: boolean
  toggleChatCollapsed: () => void

  /** 移动端 Drawer 打开状态 */
  mobileChatOpen: boolean
  setMobileChatOpen: (v: boolean) => void

  /** 全局 toast */
  toast: { id: number; text: string } | null
  pushToast: (text: string) => void

  // —— WebContainer 状态 ——
  wcStatus: WCStatus
  wcUrl: string | null
  wcLog: string  // 最近一行日志，用于展示
  wcError: string | null
  setWCStatus: (s: WCStatus) => void
  setWCUrl: (u: string | null) => void
  setWCLog: (log: string) => void
  setWCError: (e: string | null) => void
}

export const useUIStore = create<UIState>((set) => ({
  workTab: 'preview',
  setWorkTab: (workTab) => set({ workTab }),

  chatCollapsed: false,
  toggleChatCollapsed: () => set((s) => ({ chatCollapsed: !s.chatCollapsed })),

  mobileChatOpen: false,
  setMobileChatOpen: (mobileChatOpen) => set({ mobileChatOpen }),

  toast: null,
  pushToast: (text) => {
    const id = Date.now()
    set({ toast: { id, text } })
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : s))
    }, 2200)
  },

  // —— WebContainer ——
  wcStatus: 'idle',
  wcUrl: null,
  wcLog: '',
  wcError: null,
  setWCStatus: (wcStatus) => set({ wcStatus }),
  setWCUrl: (wcUrl) => set({ wcUrl }),
  setWCLog: (wcLog) => set({ wcLog }),
  setWCError: (wcError) => set({ wcError }),
}))
