import { Sun, Moon } from 'lucide-react'
import { useThemeStore } from '@/store/theme'
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

  return (
    <>
      <header className={styles.topbar}>
        <div className={styles.left}>
          <a className={styles.brand} aria-label="小筑">
            <img className={styles.brandMark} src="/logo.png" alt="小筑" />
            <span className={styles.brandText}>小筑</span>
          </a>
        </div>

        {/* 桌面端：项目 / 版本居中放在顶栏。移动端此块由 CSS 隐藏，改到下方 subbar 里 */}
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

      {/* 移动端专属第二行：顶栏太窄放不下品牌 + 项目 + 版本 + 右侧操作，
          把项目 / 版本单独下沉到这一行。桌面端由 CSS 隐藏（顶栏已居中展示它们）。 */}
      <div className={styles.subbar}>
        <ProjectMenu />
        <VersionMenu />
      </div>
    </>
  )
}
