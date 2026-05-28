import { Download, RotateCcw, Check } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useEditorStore } from '@/store/editor'
import { useUIStore } from '@/store/ui'
import { downloadVersionAsZip } from '@/lib/download'
import { shortHash, formatClock } from '@/lib/format'
import type { Version } from '@/mock/demoProjects'
import styles from './index.module.scss'

// ============================================
// 版本卡片：版本历史列表中的单元
// ============================================
type Props = {
  version: Version
  isCurrent: boolean
  projectName: string
  /** 非主线时展示分支名 */
  branchLabel?: string
  /** 选中后回调（用于关闭下拉菜单） */
  onSelect?: () => void
}

export default function VersionCard({
  version,
  isCurrent,
  projectName,
  branchLabel,
  onSelect,
}: Props) {
  const setCurrentVersion = useSessionStore((s) => s.setCurrentVersion)
  const resetEditor = useEditorStore((s) => s.reset)
  const pushToast = useUIStore((s) => s.pushToast)

  const select = () => {
    if (isCurrent) {
      onSelect?.()
      return
    }
    setCurrentVersion(version.id)
    resetEditor()
    onSelect?.()
  }

  const onDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await downloadVersionAsZip(version, projectName)
    pushToast(`已下载 ${version.id}.zip`)
  }

  const onRestore = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCurrentVersion(version.id)
    resetEditor()
    pushToast(`已切换到 ${version.id}`)
    onSelect?.()
  }

  return (
    <div
      className={`${styles.card} ${isCurrent ? styles.current : ''}`}
      onClick={select}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
    >
      <span className={styles.rail} aria-hidden>
        <span className={styles.railDot}>
          {isCurrent && <Check size={9} strokeWidth={3} />}
        </span>
      </span>

      <div className={styles.body}>
        <div className={styles.headRow}>
          <span className={styles.label}>{version.label}</span>
          {branchLabel && <span className={styles.branchTag}>{branchLabel}</span>}
          <span className={styles.versionTag}>{version.id}</span>
        </div>

        <div className={styles.meta}>
          <span className={styles.hash}>{shortHash(version.id + version.label)}</span>
          <span className={styles.diff}>
            <span className={styles.added}>+{version.diff.added}</span>
            {version.diff.removed > 0 && (
              <span className={styles.removed}>−{version.diff.removed}</span>
            )}
          </span>
          <span className={styles.clock}>{formatClock(version.createdAt)}</span>
        </div>

        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onClick={onRestore}
            aria-label="还原到此版本"
            title="还原到此版本"
          >
            <RotateCcw size={12} />
          </button>
          <button
            className={styles.actionBtn}
            onClick={onDownload}
            aria-label="下载该版本"
            title="下载该版本"
          >
            <Download size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
