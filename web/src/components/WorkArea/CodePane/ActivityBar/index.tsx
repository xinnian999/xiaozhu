import { Files, Search, Boxes, GitBranch, Settings } from 'lucide-react'
import { useState } from 'react'
import styles from './index.module.scss'

// ============================================
// Activity Bar：最左侧的图标列
// MVP 仅"文件"激活，其余占位
// ============================================
const ITEMS = [
  { key: 'files', Icon: Files, label: '文件', enabled: true },
  { key: 'search', Icon: Search, label: '搜索', enabled: false },
  { key: 'packages', Icon: Boxes, label: '依赖', enabled: false },
  { key: 'git', Icon: GitBranch, label: '版本控制', enabled: false },
]

export default function ActivityBar() {
  const [active] = useState('files')

  return (
    <nav className={styles.activity}>
      <div className={styles.top}>
        {ITEMS.map(({ key, Icon, label, enabled }) => {
          const isActive = key === active
          return (
            <button
              key={key}
              className={`${styles.item} ${isActive ? styles.active : ''} ${!enabled ? styles.disabled : ''}`}
              title={enabled ? label : `${label}（即将上线）`}
              aria-label={label}
              disabled={!enabled}
            >
              <Icon size={17} strokeWidth={1.6} />
            </button>
          )
        })}
      </div>

      <div className={styles.bottom}>
        <button className={`${styles.item} ${styles.disabled}`} title="设置" disabled>
          <Settings size={17} strokeWidth={1.6} />
        </button>
      </div>
    </nav>
  )
}
