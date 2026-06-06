import { useState } from 'react'
import type { FormEvent } from 'react'
import { X, Shuffle, Loader2 } from 'lucide-react'
import Avatar from '@/components/Avatar'
import { genAvatarSeed } from '@/lib/avatar'
import { useAuthStore } from '@/store/auth'
import { toast } from '@/lib/toast'
import styles from './index.module.scss'

// ============================================
// 修改资料弹窗：改昵称 + 换头像
// ============================================

type Props = {
  /** 关闭弹窗 */
  onClose: () => void
}

export default function EditProfileModal({ onClose }: Props) {
  const user = useAuthStore((s) => s.user)
  const updateProfile = useAuthStore((s) => s.updateProfile)

  // 本地草稿：先在弹窗里改，点保存才提交后端
  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [avatar, setAvatar] = useState(user?.avatar ?? '')
  const [saving, setSaving] = useState(false)

  // 换一个头像：本地摇个新种子，仅预览，保存后才落库
  const shuffleAvatar = () => setAvatar(genAvatarSeed())

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    const name = nickname.trim()
    if (!name) {
      toast('昵称不能为空')
      return
    }
    if (name.length > 20) {
      toast('昵称最多 20 个字')
      return
    }
    setSaving(true)
    try {
      await updateProfile({ nickname: name, avatar })
      toast('资料已更新')
      onClose()
    } catch {
      // 错误已由 axios 拦截器 toast，这里不重复提示
    } finally {
      setSaving(false)
    }
  }

  return (
    // 遮罩层：点击空白处关闭
    <div className={styles.overlay} onClick={onClose}>
      {/* 阻止冒泡，点弹窗本体不关闭 */}
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className={styles.header}>
          <h2 className={styles.title}>修改资料</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {/* 头像预览 + 换一个 */}
        <div className={styles.avatarRow}>
          <Avatar seed={avatar} size={64} title={nickname} />
          <button type="button" className={styles.shuffleBtn} onClick={shuffleAvatar}>
            <Shuffle size={14} />
            <span>换一个头像</span>
          </button>
        </div>

        {/* 昵称 */}
        <label className={styles.field}>
          <span className={styles.label}>昵称</span>
          <input
            className={styles.input}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="给自己起个名字"
            maxLength={20}
            autoFocus
          />
        </label>

        {/* 邮箱（只读展示，暂不支持改） */}
        <label className={styles.field}>
          <span className={styles.label}>邮箱</span>
          <input className={styles.input} value={user?.email ?? ''} disabled />
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            取消
          </button>
          <button type="submit" className={styles.saveBtn} disabled={saving}>
            {saving ? <Loader2 size={15} className={styles.spin} /> : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}
