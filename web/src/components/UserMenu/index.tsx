import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Pencil, LogOut } from 'lucide-react'
import Avatar from '@/components/Avatar'
import { useAuthStore } from '@/store/auth'
import { useClickOutside } from '@/hooks/useClickOutside'
import EditProfileModal from './EditProfileModal'
import styles from './index.module.scss'

// ============================================
// 顶栏：用户标签（头像 + 昵称），点击展开气泡菜单
// ============================================
// 气泡里：用户信息头部 + 「修改资料」+「退出登录」
export default function UserMenu() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  // 未登录时不渲染（理论上 UserMenu 只在已登录的主应用里出现，这里兜底）
  if (!user) return null

  const openEdit = () => {
    setOpen(false)
    setEditing(true)
  }

  return (
    <div className={styles.menu} ref={rootRef}>
      {/* 触发器：头像 + 昵称 */}
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar seed={user.avatar} size={26} title={user.nickname} />
        <span className={styles.nickname}>{user.nickname}</span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {/* 气泡菜单 */}
      {open && (
        <div className={styles.panel} role="menu" aria-label="用户菜单">
          {/* 头部：大头像 + 昵称 + 邮箱 */}
          <div className={styles.profile}>
            <Avatar seed={user.avatar} size={40} title={user.nickname} />
            <div className={styles.profileText}>
              <span className={styles.profileName}>{user.nickname}</span>
              <span className={styles.profileEmail}>{user.email}</span>
            </div>
          </div>

          <div className={styles.divider} />

          {/* 菜单项 */}
          <button type="button" role="menuitem" className={styles.item} onClick={openEdit}>
            <Pencil size={15} />
            <span>修改资料</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${styles.danger}`}
            onClick={logout}
          >
            <LogOut size={15} />
            <span>退出登录</span>
          </button>
        </div>
      )}

      {/* 修改资料弹窗 */}
      {editing && <EditProfileModal onClose={() => setEditing(false)} />}
    </div>
  )
}
