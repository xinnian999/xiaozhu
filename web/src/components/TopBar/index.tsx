import { MoreHorizontal, Download, Sun, Moon, Menu } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useThemeStore } from '@/store/theme'
import { useUIStore } from '@/store/ui'
import { downloadVersionAsZip } from '@/lib/download'
import ProjectMenu from './ProjectMenu'
import VersionMenu from './VersionMenu'
import styles from './index.module.scss'

// ============================================
// 顶部栏：品牌位 / 项目导航 / 全局操作
// ============================================
export default function TopBar() {
  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const pushToast = useUIStore((s) => s.pushToast)

  const handleDownload = async () => {
    await downloadVersionAsZip(currentVersion, session.name)
    pushToast(`已下载 ${session.name} · ${currentVersion.id}.zip`)
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
        <span className={styles.crumbSep}>/</span>
        <VersionMenu />
      </div>

      <div className={styles.right}>
        <button className={styles.iconBtn} aria-label="更多操作">
          <MoreHorizontal size={16} />
        </button>

        <button className={styles.iconBtn} onClick={handleDownload} aria-label="下载源码">
          <Download size={15} />
          <span className={styles.iconBtnLabel}>下载</span>
        </button>

        <button className={styles.iconBtn} onClick={toggleTheme} aria-label="切换主题">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  )
}
