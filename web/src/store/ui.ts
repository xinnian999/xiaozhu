import { create } from 'zustand'

// ============================================
// UI store：跨组件的瞬时 UI 状态
// ============================================

export type WorkTab = 'preview' | 'code'

/** 预览画布设备。它只决定 iframe 的 viewport，不改变生成页面必须响应式的原则。 */
export type PreviewDevice = 'desktop' | 'mobile'

const PREVIEW_DEVICE_STORAGE_KEY = 'xiaozhu:preview-device-by-session'

/** 画布偏好按会话保存，避免 H5 项目与桌面项目互相污染。
 *  localStorage 不可用或内容损坏时静默退回空表，不能让 UI store 初始化失败。 */
function getStoredPreviewDevices(): Record<string, PreviewDevice> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(PREVIEW_DEVICE_STORAGE_KEY) ?? '{}',
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([sessionId, device]) => (
          sessionId.length > 0 && (device === 'desktop' || device === 'mobile')
        ),
      ),
    )
  } catch {
    return {}
  }
}

/** 首次加载直接从 URL 中当前会话恢复，避免先闪一下桌面画布再切回 H5。 */
function getInitialPreviewDevice(): PreviewDevice {
  if (typeof window === 'undefined') return 'desktop'
  const sessionId = new URL(window.location.href).searchParams.get('sessionId')
  if (!sessionId) return 'desktop'
  return getStoredPreviewDevices()[sessionId] ?? 'desktop'
}

function storePreviewDevice(sessionId: string, device: PreviewDevice) {
  try {
    window.localStorage.setItem(
      PREVIEW_DEVICE_STORAGE_KEY,
      JSON.stringify({
        ...getStoredPreviewDevices(),
        [sessionId]: device,
      }),
    )
  } catch {
    // 隐私模式或存储空间不足时退化为仅当前页面有效，画布切换本身仍然可用。
  }
}

/** 移动端顶层视图：一次只全屏展示「聊天」或「工作区（预览/代码）」，靠顶部分段开关切换。
 *  桌面端两栏并排、不受它影响。 */
export type MobileView = 'chat' | 'work'

/** 后端沙箱预览生命周期状态 */
export type PreviewStatus =
  | 'idle'        // 未启动
  | 'building'    // Worker 正在 vite build
  | 'ready'       // 已 ready，url 可用
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

  /** 当前预览 iframe 的画布设备：桌面铺满，H5 使用真实窄 viewport。 */
  previewDevice: PreviewDevice
  /** 切换并保存当前会话的选择；sessionId 由触发切换的 UI / Agent 事件显式传入。 */
  setPreviewDevice: (device: PreviewDevice, sessionId?: string | null) => void
  /** 切换项目时恢复该项目上一次使用的画布，没有记录的新项目默认桌面。 */
  restorePreviewDevice: (sessionId: string | null) => void

  /** 左侧 Chat 是否折叠 */
  chatCollapsed: boolean
  toggleChatCollapsed: () => void

  /** 移动端顶层视图：全屏切换「对话 / 工作区」。桌面端两栏并排、忽略此值 */
  mobileView: MobileView
  setMobileView: (v: MobileView) => void

  /** 全局 toast */
  toast: { id: number; text: string } | null
  pushToast: (text: string) => void

  /** 图片放大预览：null 表示关闭，非空为要预览的图片 src（data URL 或 http 链接）。
   *  任意缩略图点击即打开，全局只有一个预览层（挂在 App 根，见 ImageLightbox）。 */
  previewImage: string | null
  openImagePreview: (src: string) => void
  closeImagePreview: () => void

  // —— 后端沙箱预览状态 ——
  previewStatus: PreviewStatus
  previewUrl: string | null
  previewLog: string  // 最近一行构建日志，用于展示
  previewError: string | null
  setPreviewStatus: (s: PreviewStatus) => void
  setPreviewUrl: (u: string | null) => void
  setPreviewLog: (log: string) => void
  setPreviewError: (e: string | null) => void

  /** 预览刷新计数：自增即触发 iframe 重挂载（用作 React key 的一部分） */
  previewReloadTick: number
  reloadPreview: () => void

  /** 预览应用请求：seq 自增触发同步与构建，checkId 把本次结果/截图绑定到对应工具卡。
   *  与 reloadPreview 的区别：这个触发「同步文件 + 重新构建」，构建成功后才由 PreviewPane
   *  调 reloadPreview 整页重载换上新 dist。 */
  previewApplyRequest: { seq: number; checkId: string | null; sessionId: string | null }
  requestPreviewApply: (checkId: string, sessionId: string) => void

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

  /** 预览 iframe 回传的浏览器 console 日志 */
  previewLogs: LogEntry[]
  pushPreviewLog: (entry: Omit<LogEntry, 'id' | 'ts'>) => void
  clearPreviewLogs: () => void
}

// 自增日志 ID，闭包持有，不污染 store
let logIdSeq = 0

export const useUIStore = create<UIState>((set) => ({
  workTab: 'preview',
  setWorkTab: (workTab) => set({ workTab }),

  previewDevice: getInitialPreviewDevice(),
  setPreviewDevice: (previewDevice, sessionId) => {
    if (sessionId) storePreviewDevice(sessionId, previewDevice)
    set({ previewDevice })
  },
  restorePreviewDevice: (sessionId) =>
    set({
      previewDevice: sessionId
        ? (getStoredPreviewDevices()[sessionId] ?? 'desktop')
        : 'desktop',
    }),

  chatCollapsed: false,
  toggleChatCollapsed: () => set((s) => ({ chatCollapsed: !s.chatCollapsed })),

  // 移动端默认停在「对话」视图 —— 首屏没有活动会话时本就只有对话，
  // 发起会话后由 ChatSidebar 自动切到「工作区」看预览（见 App）。
  mobileView: 'chat',
  setMobileView: (mobileView) => set({ mobileView }),

  toast: null,
  pushToast: (text) => {
    const id = Date.now()
    set({ toast: { id, text } })
    setTimeout(() => {
      set((s) => (s.toast?.id === id ? { toast: null } : s))
    }, 2200)
  },

  previewImage: null,
  openImagePreview: (src) => set({ previewImage: src }),
  closeImagePreview: () => set({ previewImage: null }),

  // —— 后端沙箱预览 ——
  previewStatus: 'idle',
  previewUrl: null,
  previewLog: '',
  previewError: null,
  setPreviewStatus: (previewStatus) => set({ previewStatus }),
  setPreviewUrl: (previewUrl) => set({ previewUrl }),
  setPreviewLog: (previewLog) => set({ previewLog }),
  setPreviewError: (previewError) => set({ previewError }),

  previewReloadTick: 0,
  reloadPreview: () => set((s) => ({ previewReloadTick: s.previewReloadTick + 1 })),

  previewApplyRequest: { seq: 0, checkId: null, sessionId: null },
  requestPreviewApply: (checkId, sessionId) =>
    set((s) => ({
      previewApplyRequest: {
        seq: s.previewApplyRequest.seq + 1,
        checkId,
        sessionId,
      },
    })),

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

  previewLogs: [],
  pushPreviewLog: (entry) =>
    set((s) => {
      const next: LogEntry = {
        ...entry,
        id: ++logIdSeq,
        ts: Date.now(),
      }
      const logs = s.previewLogs.length >= LOG_CAP
        ? [...s.previewLogs.slice(-(LOG_CAP - 1)), next]
        : [...s.previewLogs, next]
      return { previewLogs: logs }
    }),
  clearPreviewLogs: () => set({ previewLogs: [] }),
}))
