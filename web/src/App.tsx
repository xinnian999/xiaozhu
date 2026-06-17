import { useEffect } from 'react'
import TopBar from '@/components/TopBar'
import ChatSidebar from '@/components/ChatSidebar'
import WorkArea from '@/components/WorkArea'
import Toast from '@/components/Toast'
import ImageLightbox from '@/components/ImageLightbox'
import AuthGate from '@/components/AuthGate'
import { useThemeStore } from '@/store/theme'
import { useSessionStore } from '@/store/session'
import { useAuthStore } from '@/store/auth'
import { warmupSnapshot } from '@/lib/depsCache'
import styles from './App.module.scss'

function App() {
  const theme = useThemeStore((s) => s.theme)
  const init = useSessionStore((s) => s.init)
  const loadModels = useSessionStore((s) => s.loadModels)
  const loadBilling = useSessionStore((s) => s.loadBilling)
  // 没有激活会话时进入"空态"：隐藏右侧工作区，让对话框全屏展开
  const hasActive = useSessionStore((s) => s.activeId !== null)

  // 登录态：ready 表示首次"恢复登录态"已完成；isAuthed 表示当前已登录
  const authReady = useAuthStore((s) => s.ready)
  const isAuthed = useAuthStore((s) => s.user !== null)
  const initAuth = useAuthStore((s) => s.init)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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
      <main className={`${styles.main} ${hasActive ? '' : styles.noSession}`}>
        <ChatSidebar />
        {hasActive && <WorkArea />}
      </main>
      <Toast />
      <ImageLightbox />
    </div>
  )
}

export default App
