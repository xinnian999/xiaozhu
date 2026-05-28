import { Eye, Code2, Database, ChevronLeft, RotateCw, ExternalLink, Terminal, MoreVertical } from 'lucide-react'
import { useUIStore, type WorkTab } from '@/store/ui'
import { useSessionStore } from '@/store/session'
import styles from './index.module.scss'

// ============================================
// 工作区顶部 Tab 栏：切换 预览 / 代码 / 数据 + URL 栏
// ============================================
const TABS: { key: WorkTab; label: string; Icon: typeof Eye }[] = [
  { key: 'preview', label: '预览', Icon: Eye },
  { key: 'code', label: '代码', Icon: Code2 },
  { key: 'data', label: '数据', Icon: Database },
]

export default function TabBar() {
  const workTab = useUIStore((s) => s.workTab)
  const setWorkTab = useUIStore((s) => s.setWorkTab)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)
  const toggleChat = useUIStore((s) => s.toggleChatCollapsed)
  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())

  return (
    <div className={styles.tabbar}>
      <div className={styles.left}>
        <button
          className={`${styles.collapseBtn} ${chatCollapsed ? styles.isCollapsed : ''}`}
          onClick={toggleChat}
          aria-label={chatCollapsed ? '展开侧栏' : '折叠侧栏'}
          title={chatCollapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <ChevronLeft size={14} />
        </button>

        {/* Tabs */}
        <div className={styles.tabs}>
          {TABS.map(({ key, label, Icon }) => {
            const active = key === workTab
            return (
              <button
                key={key}
                className={`${styles.tab} ${active ? styles.active : ''}`}
                onClick={() => setWorkTab(key)}
              >
                <Icon size={13} />
                <span>{label}</span>
              </button>
            )
          })}
          {/* 激活态滑块的位置由 data-active 控制 */}
          <span
            className={styles.tabIndicator}
            aria-hidden
            data-active={workTab}
          />
        </div>
      </div>

      {/* 中间：地址栏（仅 preview tab 显示状态） */}
      <div className={styles.center}>
        <div className={styles.urlBar}>
          <button className={styles.urlIconBtn} aria-label="后退">
            <ChevronLeft size={13} />
          </button>
          <button className={styles.urlIconBtn} aria-label="前进">
            <ChevronLeft size={13} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button className={styles.urlIconBtn} aria-label="刷新">
            <RotateCw size={12} />
          </button>

          <div className={styles.urlInput}>
            <span className={styles.urlBrand} aria-hidden>vb</span>
            <span className={styles.urlPath}>{session.name.toLowerCase().replace(/\s+/g, '-')}.vibuild.app</span>
            <span className={styles.urlVersionTag}>{currentVersion.id}</span>
          </div>

          <button className={styles.urlIconBtn} aria-label="新窗口打开">
            <ExternalLink size={12} />
          </button>
        </div>
      </div>

      <div className={styles.right}>
        <button className={styles.iconBtn} aria-label="终端" title="终端">
          <Terminal size={14} />
        </button>
        <button className={styles.iconBtn} aria-label="更多" title="更多">
          <MoreVertical size={14} />
        </button>
      </div>
    </div>
  )
}
