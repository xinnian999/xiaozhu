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

  /** 预览应用计数：自增即把当前暂存文件同步进运行中的预览（增量 syncFiles，走 vite HMR）。
   *  与 reloadPreview 的区别：这个是「把新文件应用进去」（软更新），不重挂 iframe；
   *  reloadPreview 是「整页重载」（硬刷新）。AI 调 update_preview / 流结束兜底时自增它。 */
  previewApplyTick: number
  requestPreviewApply: () => void

  // —— 预览路由导航（地址栏 + 前进后退）——
  // iframe 跨域，父页面读不到它的 URL，靠注入的导航桥 postMessage 上报，
  // 这里集中存：当前路径、能否前进/后退（由 PreviewPane 维护的历史栈算出）。
  /** 当前预览路由路径（pathname+search+hash），默认 '/' */
  previewPath: string
  previewCanBack: boolean
  previewCanForward: boolean
  setPreviewNav: (s: { path: string; canBack: boolean; canForward: boolean }) => void
  /** 切会话 / 重挂时复位回初始态 */
  resetPreviewNav: () => void

  /** 发给 iframe 的导航指令：seq 自增触发 PreviewPane 把指令 postMessage 进 iframe。
   *  用计数器而非直接调用，是因为只有 PreviewPane 持有 iframe 引用。 */
  previewNavCmd: { seq: number; action: 'back' | 'forward' | 'reload' }
  sendPreviewNav: (action: 'back' | 'forward' | 'reload') => void

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

  previewApplyTick: 0,
  requestPreviewApply: () => set((s) => ({ previewApplyTick: s.previewApplyTick + 1 })),

  previewPath: '/',
  previewCanBack: false,
  previewCanForward: false,
  setPreviewNav: ({ path, canBack, canForward }) =>
    set({ previewPath: path, previewCanBack: canBack, previewCanForward: canForward }),
  resetPreviewNav: () =>
    set({ previewPath: '/', previewCanBack: false, previewCanForward: false }),

  previewNavCmd: { seq: 0, action: 'reload' },
  sendPreviewNav: (action) =>
    set((s) => ({ previewNavCmd: { seq: s.previewNavCmd.seq + 1, action } })),

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
