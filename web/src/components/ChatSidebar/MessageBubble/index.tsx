import { Sparkles } from 'lucide-react'
import { formatClock } from '@/lib/format'
import type { Message } from '@/types/project'
import styles from './index.module.scss'

type Props = {
  message: Message
  /** 是否正在流式输出（显示光标动画，隐藏时间戳） */
  isStreaming?: boolean
}

// ============================================
// 单条对话气泡
// ============================================
export default function MessageBubble({ message, isStreaming = false }: Props) {
  const isUser = message.role === 'user'

  return (
    <article className={`${styles.bubble} ${isUser ? styles.user : styles.assistant}`}>
      {!isUser && (
        <span className={styles.avatar} aria-hidden>
          <Sparkles size={12} />
        </span>
      )}

      <div className={styles.content}>
        <p className={styles.text}>
          {message.text}
          {/* 流式输出时在文字末尾追加闪烁光标 */}
          {isStreaming && <span className={styles.cursor} aria-hidden />}
        </p>

        {!isStreaming && (
          <time className={styles.time} dateTime={new Date(message.createdAt).toISOString()}>
            {formatClock(message.createdAt)}
          </time>
        )}
      </div>
    </article>
  )
}
