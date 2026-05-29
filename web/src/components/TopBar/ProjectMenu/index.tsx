import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Check, Plus } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { useClickOutside } from '@/hooks/useClickOutside'
import styles from './index.module.scss'

// ============================================
// 顶栏：会话切换下拉
// ============================================
export default function ProjectMenu() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const activeSession = useSessionStore((s) => s.activeSession())
  const switchTo = useSessionStore((s) => s.switchTo)
  const createNew = useSessionStore((s) => s.createNew)
  const pushToast = useUIStore((s) => s.pushToast)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  const handleSelect = (id: string) => {
    switchTo(id)
    close()
  }

  const handleCreate = async () => {
    close()
    await createNew()
    pushToast('已创建新会话')
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
        <span className={styles.projectName}>{activeSession?.title ?? '加载中…'}</span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="选择会话">
          <p className={styles.panelTitle}>会话</p>
          <ul className={styles.list}>
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.item} ${s.id === activeId ? styles.itemActive : ''}`}
                  onClick={() => handleSelect(s.id)}
                >
                  <span className={styles.itemMain}>
                    <span className={styles.itemName}>{s.title}</span>
                    <span className={styles.itemMeta}>{s.messages.length} 条消息</span>
                  </span>
                  {s.id === activeId && <Check size={14} className={styles.itemCheck} />}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.createBtn} onClick={handleCreate}>
            <Plus size={14} />
            <span>新建会话</span>
          </button>
        </div>
      )}
    </div>
  )
}
