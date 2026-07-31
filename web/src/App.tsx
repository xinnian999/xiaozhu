import { lazy, Suspense, useEffect } from 'react'
import TopBar from '@/components/TopBar'
import ChatSidebar from '@/components/ChatSidebar'
import MobileViewSwitch from '@/components/MobileViewSwitch'
import Toast from '@/components/Toast'
import ImageLightbox from '@/components/ImageLightbox'
import AuthGate from '@/components/AuthGate'
import { useThemeStore } from '@/store/theme'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { useAuthStore } from '@/store/auth'
import { getSetupStatus } from '@/lib/api'
import styles from './App.module.scss'

// WorkArea 含 Monaco 编辑器等重型依赖，且仅在有活动会话时才用，
// 故懒加载成独立 chunk —— 首屏初始包不含这些，大幅缩短第一次打开的白屏时间。
const WorkArea = lazy(() => import('@/components/WorkArea'))

function App() {
  const theme = useThemeStore((s) => s.theme)
  const init = useSessionStore((s) => s.init)
  const loadModels = useSessionStore((s) => s.loadModels)
  const loadBilling = useSessionStore((s) => s.loadBilling)
  const activeId = useSessionStore((s) => s.activeId)
  const hasActive = activeId !== null
  // 新项目的模板文件会在创建会话时立即加载，但这不代表第一版已经写完。
  // 时间线首次出现 check_build / 版本卡后永久揭晓工作区；重新生成虽会截掉旧卡片，
  // 上一版稳定预览仍要保留，不能把整个 WorkArea 卸载掉。
  const hasPreviewHistory = useSessionStore((s) => {
    const active = s.sessions.find((session) => session.id === s.activeId)
    return !!(active?.previewRevealed || active?.messages.some((message) => (
        message.kind === 'version'
        || (message.kind === 'tool' && message.toolName === 'check_build')
      )))
  })
  // 移动端顶层视图（对话 / 工作区）：桌面端两栏并排、忽略它。有活动会话时才需要切换
  const mobileView = useUIStore((s) => s.mobileView)
  const previewApplySessionId = useUIStore((s) => s.previewApplyRequest.sessionId)
  // preview_refresh 可能紧跟在 tool_call 后抵达；把它也作为揭晓信号，保证 WorkArea
  // 即使尚未来得及响应消息更新，挂载后仍能消费已经进入 store 的构建请求。
  const showWorkArea = hasActive && (
    hasPreviewHistory || previewApplySessionId === activeId
  )

  // 登录态：ready 表示首次"恢复登录态"已完成；isAuthed 表示当前已登录
  const authReady = useAuthStore((s) => s.ready)
  const isAuthed = useAuthStore((s) => s.user !== null)
  const initAuth = useAuthStore((s) => s.init)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 应用启动：先查系统是否已初始化。未初始化（全新部署、库里没管理员）→ 整站导去 /setup 向导。
  // 为什么放前端做：开发期前台由 Vite 直接服务、不经过后端的初始化闸门中间件，靠这次查询兜住。
  // window.location 硬跳转（而非 React 路由）：/setup 是后端渲染的独立页面，不在 SPA 里。
  useEffect(() => {
    getSetupStatus().then((initialized) => {
      if (!initialized) {
        window.location.href = '/setup'
      }
    })
  }, [])

  // 应用启动：恢复登录态（看本地 token 是否有效）。
  useEffect(() => {
    initAuth()
  }, [initAuth])

  // 登录成功后才初始化会话和模型清单（这些接口需要鉴权）。
  // isAuthed 变 true 时触发；未登录时不会调用，避免无意义的 401。
  useEffect(() => {
    if (!isAuthed) return
    // 错误统一由 axios 拦截器 toast，这里只需阻止 unhandled rejection
    init().catch(() => {})
    loadModels()
    loadBilling() // 拉一次额度，渲染「今日剩余」；之后每轮对话结束会再刷新
  }, [init, isAuthed, loadBilling, loadModels])

  // 登录态还没恢复完：先显示加载占位，避免"已登录却闪一下登录页"
  if (!authReady) {
    return <div className={styles.booting}>加载中…</div>
  }

  // 未登录：挡在登录门前
  if (!isAuthed) {
    return (
      <>
        <AuthGate />
        <Toast />
      </>
    )
  }

  return (
    <div className={styles.app}>
      <TopBar />
      {/* 第一版首次 check_build 前只展示对话；揭晓后再进入桌面双栏 / 移动端切换。 */}
      <main
        className={`${styles.main} ${showWorkArea ? '' : styles.singlePane}`}
        data-mobile-view={showWorkArea ? mobileView : 'chat'}
      >
        <ChatSidebar conversationOnly={hasActive && !showWorkArea} />
        {showWorkArea && (
          <Suspense fallback={<div className={styles.workLoading}>加载工作区…</div>}>
            <WorkArea />
          </Suspense>
        )}
      </main>
      {/* 第一次 check_build 前没有工作区，移动端也不展示无效的“预览”入口。 */}
      {showWorkArea && <MobileViewSwitch />}
      <Toast />
      <ImageLightbox />
    </div>
  )
}

export default App
