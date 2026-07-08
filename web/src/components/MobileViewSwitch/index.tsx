import { MessageSquare, Eye } from 'lucide-react'
import { useUIStore, type MobileView } from '@/store/ui'
import styles from './index.module.scss'

// ============================================
// 移动端底部视图开关：对话 ⇄ 预览
// - 移动端屏幕窄，聊天与工作区无法并排，改为一次全屏展示其一
// - 用底部一枚分段控件在两者间切换（发起会话后 App 会自动切到「预览」）
// - 桌面端由 CSS 隐藏（两栏本就并排展示，不需要这个开关）
// ============================================
const VIEWS: { key: MobileView; label: string; Icon: typeof Eye }[] = [
  { key: 'chat', label: '对话', Icon: MessageSquare },
  { key: 'work', label: '预览', Icon: Eye },
]

export default function MobileViewSwitch() {
  const mobileView = useUIStore((s) => s.mobileView)
  const setMobileView = useUIStore((s) => s.setMobileView)

  return (
    <nav className={styles.switch} aria-label="切换视图">
      {VIEWS.map(({ key, label, Icon }) => {
        const active = key === mobileView
        return (
          <button
            key={key}
            className={`${styles.seg} ${active ? styles.active : ''}`}
            onClick={() => setMobileView(key)}
            aria-pressed={active}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        )
      })}
      {/* 激活态滑块：位置由 data-active 决定，与 TabBar 的做法一致 */}
      <span className={styles.indicator} aria-hidden data-active={mobileView} />
    </nav>
  )
}
