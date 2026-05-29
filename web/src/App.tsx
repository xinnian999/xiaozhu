import { useEffect } from 'react'
import TopBar from '@/components/TopBar'
import ChatSidebar from '@/components/ChatSidebar'
import WorkArea from '@/components/WorkArea'
import Toast from '@/components/Toast'
import { useThemeStore } from '@/store/theme'
import styles from './App.module.scss'

// ============================================
// 应用主入口：垂直 TopBar + 水平 Chat / Work
// ============================================
function App() {
  const theme = useThemeStore((s) => s.theme)

  // 初次挂载时把主题写到 html，保持与持久化一致
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <div className={styles.app}>
      <TopBar />
      <main className={styles.main}>
        <ChatSidebar />
        <WorkArea />
      </main>
      <Toast />
    </div>
  )
}

export default App
