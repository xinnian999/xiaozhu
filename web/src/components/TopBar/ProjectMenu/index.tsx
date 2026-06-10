import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Plus, FolderKanban, Pencil, Trash2 } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import styles from './index.module.scss'

// ============================================
// 顶栏：项目切换下拉（支持重命名 / 删除）
// ============================================
export default function ProjectMenu() {
  const [open, setOpen] = useState(false)
  // 正在内联重命名的会话 id（null 表示没有任何一项处于编辑态）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // 正在等待二次确认删除的会话 id
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // 标记「这次 input 失焦是因为按了 Esc 取消」，让 onBlur 区分提交还是放弃
  const cancelRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const activeSession = useSessionStore((s) => s.activeSession())
  const switchTo = useSessionStore((s) => s.switchTo)
  const goToEmpty = useSessionStore((s) => s.goToEmpty)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)

  // 关闭面板时一并清掉编辑/确认中间态，下次打开是干净的
  const close = useCallback(() => {
    setOpen(false)
    setEditingId(null)
    setConfirmId(null)
  }, [])
  useClickOutside(rootRef, close)

  const handleSelect = (id: string) => {
    switchTo(id)
    close()
  }

  // 「新建项目」= 回到空态首屏（不立即建库），等用户发首条消息时再真正创建
  // 行为与首屏一致，避免出现空项目占位
  const handleCreate = () => {
    close()
    goToEmpty()
  }

  // ── 重命名 ───────────────────────────────────────────
  const startEdit = (id: string, title: string) => {
    setConfirmId(null) // 互斥：进入重命名就退出删除确认
    setEditingId(id)
    setEditValue(title)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }
  // 提交重命名（唯一收口在 onBlur）：空标题或没改动则放弃，否则调 store
  const commitRename = (id: string) => {
    const title = editValue.trim()
    const current = sessions.find((s) => s.id === id)
    cancelEdit()
    if (!title || title === current?.title) return
    void renameSession(id, title) // 失败由 axios 拦截器统一 toast，这里不阻塞 UI
  }

  // ── 删除 ─────────────────────────────────────────────
  const doDelete = (id: string) => {
    setConfirmId(null)
    void deleteSession(id)
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
        {/* 没有激活项目时显示提示而不是「加载中…」—— 此时是用户刚进入空态首屏 */}
        <FolderKanban size={14} className={styles.projectIcon} aria-hidden />
        <span className={styles.projectName}>
          {activeSession?.title ?? (sessions.length > 0 ? '选择项目' : '尚无项目')}
        </span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="选择项目">
          <p className={styles.panelTitle}>项目</p>
          <ul className={styles.list}>
            {sessions.map((s) => (
              <li key={s.id}>
                {editingId === s.id ? (
                  // ── 内联重命名输入框 ──
                  <div className={styles.editWrap}>
                    <input
                      className={styles.editInput}
                      value={editValue}
                      autoFocus
                      maxLength={50}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur() // 回车=提交（触发 onBlur）
                        else if (e.key === 'Escape') {
                          cancelRef.current = true // 标记为取消，onBlur 据此放弃提交
                          e.currentTarget.blur()
                        }
                      }}
                      onBlur={() => {
                        if (cancelRef.current) {
                          cancelRef.current = false
                          cancelEdit()
                          return
                        }
                        commitRename(s.id)
                      }}
                    />
                  </div>
                ) : confirmId === s.id ? (
                  // ── 删除二次确认 ──
                  <div className={styles.confirm}>
                    <span className={styles.confirmText}>删除「{s.title}」？</span>
                    <button
                      type="button"
                      className={styles.confirmYes}
                      onClick={() => doDelete(s.id)}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className={styles.confirmNo}
                      onClick={() => setConfirmId(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  // ── 普通行：选择 + 重命名 + 删除 ──
                  <div
                    className={`${styles.item} ${s.id === activeId ? styles.itemActive : ''}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.itemSelect}
                      onClick={() => handleSelect(s.id)}
                    >
                      <span className={styles.itemMain}>
                        <span className={styles.itemName}>{s.title}</span>
                        <span className={styles.itemMeta}>{s.messages.length} 条消息</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      title="重命名"
                      aria-label="重命名"
                      onClick={() => startEdit(s.id, s.title)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.actionDelete}`}
                      title="删除"
                      aria-label="删除"
                      onClick={() => setConfirmId(s.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </li>
            ))}
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
