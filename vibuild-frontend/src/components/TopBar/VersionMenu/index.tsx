import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import { buildVersionTree, flattenVersionTree, getBranchLabel } from '@/lib/sessionBranch'
import VersionCard from '@/components/VersionCard'
import styles from './index.module.scss'

// ============================================
// 顶栏：版本切换下拉（树形展示，分支以子节点呈现）
// ============================================
export default function VersionMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())

  // 把版本扁平化为带 depth / 分叉信息的渲染行
  const rows = useMemo(
    () => flattenVersionTree(buildVersionTree(session)),
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
          <div className={styles.tree}>
            {rows.map((row) => {
              const branchId = row.version.branchId
              return (
                <div
                  key={row.version.id}
                  className={styles.row}
                  style={{ '--depth': row.depth } as React.CSSProperties}
                >
                  {/* 缩进 + 分叉 rail：每一级一个槽位 */}
                  <div className={styles.indent} aria-hidden>
                    {Array.from({ length: row.depth }).map((_, i) => (
                      <span key={i} className={styles.indentSlot}>
                        {i === row.depth - 1 && row.isBranchRoot ? (
                          <span className={styles.elbow}>└</span>
                        ) : (
                          <span className={styles.vline} />
                        )}
                      </span>
                    ))}
                  </div>
                  <div className={styles.cardWrap}>
                    <VersionCard
                      version={row.version}
                      isCurrent={row.version.id === session.currentVersionId}
                      projectName={session.name}
                      branchLabel={
                        row.isBranchRoot ? getBranchLabel(session, branchId) : undefined
                      }
                      onSelect={close}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
