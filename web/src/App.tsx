import { useEffect } from 'react'
import TopBar from '@/components/TopBar'
import ChatSidebar from '@/components/ChatSidebar'
import WorkArea from '@/components/WorkArea'
import Toast from '@/components/Toast'
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
  // 没有激活会话时进入"空态"：隐藏右侧工作区，让对话框全屏展开
  const hasActive = useSessionStore((s) => s.activeId !== null)

  // 登录态：ready 表示首次"恢复登录态"已完成；isAuthed 表示当前已登录
  const authReady = useAuthStore((s) => s.ready)
  const isAuthed = useAuthStore((s) => s.user !== null)
  const initAuth = useAuthStore((s) => s.init)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // 应用启动：先恢复登录态（看本地 token 是否有效）。
  // 同时后台预热依赖快照 —— 这一步不需要登录，越早开始越好。
  useEffect(() => {
    initAuth()
    warmupSnapshot()
  }, [])

  // 登录成功后才初始化会话和模型清单（这些接口需要鉴权）。
  // isAuthed 变 true 时触发；未登录时不会调用，避免无意义的 401。
  useEffect(() => {
    if (!isAuthed) return
    // 错误统一由 axios 拦截器 toast，这里只需阻止 unhandled rejection
    init().catch(() => {})
    loadModels()
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
    </div>
  )
}

export default App
