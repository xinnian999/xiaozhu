import { useState } from 'react'
import { Download, Sun, Moon, Menu, Loader2 } from 'lucide-react'
import { useThemeStore } from '@/store/theme'
import { useUIStore } from '@/store/ui'
import { useSessionStore } from '@/store/session'
import { downloadSourceAsZip } from '@/lib/download'
import ProjectMenu from './ProjectMenu'
import VersionMenu from './VersionMenu'
import styles from './index.module.scss'

// ============================================
// 顶部栏：品牌位 / 会话导航 / 全局操作
// ============================================
export default function TopBar() {
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  // 订阅 activeId：没有激活会话时禁用下载按钮
  const activeId = useSessionStore((s) => s.activeId)
  // 打包过程中的忙碌态，避免重复点击
  const [downloading, setDownloading] = useState(false)

  // 下载当前会话源码：取当前文件快照打包成 zip
  const handleDownload = async () => {
    if (downloading) return
    const { activeSession, currentVersion } = useSessionStore.getState()
    const session = activeSession()
    if (!session) return
    const files = currentVersion().files
    if (Object.keys(files).length === 0) return
    setDownloading(true)
    try {
      await downloadSourceAsZip(files, session.title)
    } catch (e) {
      console.error('下载源码失败', e)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <button
          className={styles.mobileMenuBtn}
          onClick={() => setMobileChatOpen(true)}
          aria-label="打开侧栏"
        >
          <Menu size={18} />
        </button>

        <a className={styles.brand} aria-label="vibuild">
          <span className={styles.brandMark}>vb</span>
          <span className={styles.brandText}>vibuild</span>
        </a>
      </div>

      <div className={styles.center}>
        <ProjectMenu />
        <VersionMenu />
      </div>

      <div className={styles.right}>
        <button
          className={styles.iconBtn}
          onClick={handleDownload}
          disabled={!activeId || downloading}
          aria-label="下载源码"
        >
          {downloading ? (
            <Loader2 size={15} className={styles.spin} />
          ) : (
            <Download size={15} />
          )}
          <span className={styles.iconBtnLabel}>下载源码</span>
        </button>

        <button className={styles.iconBtn} onClick={toggleTheme} aria-label="切换主题">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  )
}
