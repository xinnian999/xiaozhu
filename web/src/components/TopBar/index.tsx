import { Sun, Moon, Menu } from 'lucide-react'
import { useThemeStore } from '@/store/theme'
import { useUIStore } from '@/store/ui'
import ProjectMenu from './ProjectMenu'
import VersionMenu from './VersionMenu'
import CreditsBadge from './CreditsBadge'
import UserMenu from '@/components/UserMenu'
import styles from './index.module.scss'

// ============================================
// 顶部栏：品牌位 / 项目导航 / 全局操作
// ============================================
export default function TopBar() {
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)

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

        <a className={styles.brand} aria-label="小筑">
          <img className={styles.brandMark} src="/logo.png" alt="小筑" />
          <span className={styles.brandText}>小筑</span>
        </a>
      </div>

      <div className={styles.center}>
        <ProjectMenu />
        <VersionMenu />
      </div>

      <div className={styles.right}>
        <button className={styles.iconBtn} onClick={toggleTheme} aria-label="切换主题">
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        {/* 积分：今日剩余额度标签，点击展开订阅信息 + 升级入口 */}
        <CreditsBadge />

        {/* 用户标签：头像 + 昵称，点击展开气泡（改资料 / 退出登录） */}
        <UserMenu />
      </div>
    </header>
  )
}
