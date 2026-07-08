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
import { warmupSnapshot } from '@/lib/depsCache'
import { getSetupStatus } from '@/lib/api'
import styles from './App.module.scss'

// WorkArea 含 Monaco 编辑器 / WebContainer / xterm 等重型依赖，且仅在有活动会话时才用，
// 故懒加载成独立 chunk —— 首屏初始包不含这些，大幅缩短第一次打开的白屏时间。
const WorkArea = lazy(() => import('@/components/WorkArea'))

function App() {
  const theme = useThemeStore((s) => s.theme)
  const init = useSessionStore((s) => s.init)
  const loadModels = useSessionStore((s) => s.loadModels)
  const loadBilling = useSessionStore((s) => s.loadBilling)
  // 没有激活会话时进入"空态"：隐藏右侧工作区，让对话框全屏展开
  const hasActive = useSessionStore((s) => s.activeId !== null)
  // 移动端顶层视图（对话 / 工作区）：桌面端两栏并排、忽略它。有活动会话时才需要切换
  const mobileView = useUIStore((s) => s.mobileView)

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
  }, [])

  // 登录成功后才初始化会话和模型清单（这些接口需要鉴权）。
  // isAuthed 变 true 时触发；未登录时不会调用，避免无意义的 401。
  useEffect(() => {
    if (!isAuthed) return
    // 错误统一由 axios 拦截器 toast，这里只需阻止 unhandled rejection
    init().catch(() => {})
    loadModels()
    loadBilling() // 拉一次额度，渲染「今日剩余」；之后每轮对话结束会再刷新
    // 依赖快照预热放到登录之后再启动 —— 它是个几 MB 的下载，登录前就开跑会和
    // 登录/拉会话等首屏请求抢带宽，把首次登录拖慢。登录后才需要它（进项目 boot
    // WebContainer 时用），这里启动既不耽误它就绪、又不挡登录。配合 fetch 的
    // priority:'low'，它会一直给前台请求让路。
    warmupSnapshot()
  }, [isAuthed])

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
      {/* data-mobile-view 只在移动端由 CSS 消费：决定全屏展示对话还是工作区。
          没有活动会话时移动端只有对话，强制回到 'chat'，避免露出空工作区。 */}
      <main
        className={`${styles.main} ${hasActive ? '' : styles.noSession}`}
        data-mobile-view={hasActive ? mobileView : 'chat'}
      >
        <ChatSidebar />
        {hasActive && (
          <Suspense fallback={<div className={styles.workLoading}>加载工作区…</div>}>
            <WorkArea />
          </Suspense>
        )}
      </main>
      {/* 移动端底部分段开关：对话 ⇄ 预览。仅有活动会话时显示（空态无工作区可切） */}
      {hasActive && <MobileViewSwitch />}
      <Toast />
      <ImageLightbox />
    </div>
  )
}

export default App
