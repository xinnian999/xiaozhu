import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Check, Plus } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { useClickOutside } from '@/hooks/useClickOutside'
import styles from './index.module.scss'

// ============================================
// 顶栏：项目切换下拉（本机项目）
// ============================================
export default function ProjectMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const projects = useSessionStore((s) => s.projects)
  const session = useSessionStore((s) => s.session)
  const setCurrentProject = useSessionStore((s) => s.setCurrentProject)
  const createProject = useSessionStore((s) => s.createProject)
  const pushToast = useUIStore((s) => s.pushToast)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  const handleSelect = (projectId: string) => {
    setCurrentProject(projectId)
    close()
  }

  const handleCreate = () => {
    const project = createProject()
    close()
    pushToast(`已创建项目「${project.name}」`)
  }

  return (
    <div className={styles.menu} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={styles.projectName}>{session.name}</span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="选择项目">
          <p className={styles.panelTitle}>项目</p>
          <ul className={styles.list}>
            {projects.map((p) => {
              const active = p.id === session.id
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`${styles.item} ${active ? styles.itemActive : ''}`}
                    onClick={() => handleSelect(p.id)}
                  >
                    <span className={styles.itemMain}>
                      <span className={styles.itemName}>{p.name}</span>
                      <span className={styles.itemMeta}>{p.versions.length} 个版本</span>
                    </span>
                    {active && <Check size={14} className={styles.itemCheck} />}
                  </button>
                </li>
              )
            })}
          </ul>
          <button type="button" className={styles.createBtn} onClick={handleCreate}>
            <Plus size={14} />
            <span>新建项目</span>
          </button>
        </div>
      )}
    </div>
  )
}
