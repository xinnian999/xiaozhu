import { useEffect } from 'react'
import TopBar from '@/components/TopBar'
import ChatSidebar from '@/components/ChatSidebar'
import WorkArea from '@/components/WorkArea'
import Toast from '@/components/Toast'
import { useThemeStore } from '@/store/theme'
import { useSessionStore } from '@/store/session'
import { warmupSnapshot } from '@/lib/depsCache'
import styles from './App.module.scss'

function App() {
  const theme = useThemeStore((s) => s.theme)
  const init = useSessionStore((s) => s.init)
  const loadModels = useSessionStore((s) => s.loadModels)
  // 没有激活会话时进入"空态"：隐藏右侧工作区，让对话框全屏展开
  const hasActive = useSessionStore((s) => s.activeId !== null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    // 错误统一由 axios 拦截器 toast，这里只需阻止 unhandled rejection
    init().catch(() => {})
    // 拉取可选模型清单，供聊天框的模型下拉框渲染
    loadModels()
    // 后台预热：页面一加载就悄悄把 node_modules 快照下好存进 IndexedDB，
    // 等用户输入完第一条需求触发 boot 时直接命中本地缓存，无感知
    warmupSnapshot()
  }, [])

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
