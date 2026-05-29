import { Sparkles } from 'lucide-react'
import { formatClock } from '@/lib/format'
import type { Message, Version } from '@/types/project'
import styles from './index.module.scss'

type Props = {
  message: Message
  /** assistant 消息产出的版本（用于展示版本标签） */
  producedVersion?: Version
  isVersionCurrent: boolean
  onVersionClick?: (versionId: string) => void
}

// ============================================
// 单条对话气泡
// ============================================
export default function MessageBubble({
  message,
  producedVersion,
  isVersionCurrent,
  onVersionClick,
}: Props) {
  const isUser = message.role === 'user'

  return (
    <article
      className={`${styles.bubble} ${isUser ? styles.user : styles.assistant}`}
    >
      {!isUser && (
        <span className={styles.avatar} aria-hidden>
          <Sparkles size={12} />
        </span>
      )}

      <div className={styles.content}>
        <p className={styles.text}>{message.text}</p>

        {!isUser && producedVersion && (
          <button
            type="button"
            className={`${styles.versionChip} ${isVersionCurrent ? styles.versionChipCurrent : ''}`}
            onClick={() => onVersionClick?.(producedVersion.id)}
            title={`切换到 ${producedVersion.id}`}
          >
            <span className={styles.versionId}>{producedVersion.id}</span>
            <span className={styles.versionLabel}>{producedVersion.label}</span>
          </button>
        )}

        <time className={styles.time} dateTime={new Date(message.createdAt).toISOString()}>
          {formatClock(message.createdAt)}
        </time>
      </div>
    </article>
  )
}
