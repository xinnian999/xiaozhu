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

/** 浏览器 console 一条日志的级别 */
export type LogLevel = 'log' | 'info' | 'warn' | 'error'

export type LogEntry = {
  id: number
  level: LogLevel
  text: string
  ts: number
}

// 日志在内存里保留的最大条数 —— 超过则丢最早一条
const LOG_CAP = 500

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

  /** 预览刷新计数：自增即触发 iframe 重挂载（用作 React key 的一部分） */
  previewReloadTick: number
  reloadPreview: () => void

  // —— 控制台日志 ——
  /** 控制台是否展开（底部抽屉） */
  consoleOpen: boolean
  toggleConsole: () => void
  setConsoleOpen: (v: boolean) => void

  /** 控制台抽屉高度（像素），用户可拖拽调整 */
  consoleHeight: number
  setConsoleHeight: (h: number) => void

  /** 浏览器 console 日志条目（node 进程走 xterm 自己渲染，不入此处） */
  wcLogs: LogEntry[]
  pushWcLog: (entry: Omit<LogEntry, 'id' | 'ts'>) => void
  clearWcLogs: () => void
}

// 自增日志 ID，闭包持有，不污染 store
let logIdSeq = 0

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

  previewReloadTick: 0,
  reloadPreview: () => set((s) => ({ previewReloadTick: s.previewReloadTick + 1 })),

  // —— 控制台 ——
  consoleOpen: false,
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),

  consoleHeight: 240,
  setConsoleHeight: (consoleHeight) => set({ consoleHeight }),

  wcLogs: [],
  pushWcLog: (entry) =>
    set((s) => {
      const next: LogEntry = {
        ...entry,
        id: ++logIdSeq,
        ts: Date.now(),
      }
      const logs = s.wcLogs.length >= LOG_CAP
        ? [...s.wcLogs.slice(-(LOG_CAP - 1)), next]
        : [...s.wcLogs, next]
      return { wcLogs: logs }
    }),
  clearWcLogs: () => set({ wcLogs: [] }),
}))
