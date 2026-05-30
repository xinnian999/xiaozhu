import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Check, Plus } from 'lucide-react'
import { useSessionStore } from '@/store/session'
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
  const goToEmpty = useSessionStore((s) => s.goToEmpty)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  const handleSelect = (id: string) => {
    switchTo(id)
    close()
  }

  // "新建会话"= 回到空态首屏（不立即建库），等用户发首条消息时再真正创建
  // 行为与首屏一致，避免出现"空会话"
  const handleCreate = () => {
    close()
    goToEmpty()
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
        {/* 没有激活会话时显示提示而不是"加载中…" —— 此时是用户刚进入空态首屏 */}
        <span className={styles.projectName}>
          {activeSession?.title ?? (sessions.length > 0 ? '选择会话' : '尚无会话')}
        </span>
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
