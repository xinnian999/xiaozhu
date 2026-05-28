import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import { groupVersionsByBranch } from '@/lib/sessionBranch'
import VersionCard from '@/components/VersionCard'
import styles from './index.module.scss'

// ============================================
// 顶栏：版本切换下拉（按分支分组，不截断历史版本）
// ============================================
export default function VersionMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())

  const branchGroups = useMemo(
    () => groupVersionsByBranch(session),
    [session.id, session.versions],
  )

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  return (
    <div className={styles.menu} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={styles.label}>{currentVersion.label}</span>
        <span className={styles.versionTag}>{currentVersion.id}</span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="版本历史">
          <p className={styles.panelTitle}>版本历史</p>
          <p className={styles.panelDesc}>所有分支均保留，可随时切回</p>
          <div className={styles.groups}>
            {branchGroups.map((group) => (
              <section key={group.branchId} className={styles.group}>
                <h3 className={styles.groupTitle}>{group.label}</h3>
                <div className={styles.list}>
                  {group.versions.map((v) => (
                    <VersionCard
                      key={v.id}
                      version={v}
                      isCurrent={v.id === session.currentVersionId}
                      projectName={session.name}
                      branchLabel={group.branchId === 'main' ? undefined : group.label}
                      onSelect={close}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
