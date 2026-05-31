import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import MessageBubble from '../MessageBubble'
import styles from './index.module.scss'

// ============================================
// 对话列表：渲染当前会话消息 + 流式输出中的 AI 消息
// ============================================
export default function MessageList() {
  const session = useSessionStore((s) => s.activeSession())
  const endRef = useRef<HTMLDivElement>(null)

  const messages = session?.messages ?? []
  const isStreaming = session?.isStreaming ?? false

  // 新消息到来 / 进入思考态时滚动到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, isStreaming])

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className={styles.empty}>
        <MessageSquare size={20} className={styles.emptyIcon} />
        <p className={styles.emptyTitle}>还没有对话</p>
        <p className={styles.emptyHint}>在下方输入需求，开始生成第一个版本</p>
      </div>
    )
  }

  return (
    <div className={styles.list}>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* 生成中：不再逐字显示打字，改成带扫光动画的「正在思考中」 */}
      {isStreaming && (
        <div className={styles.thinking} aria-live="polite">
          正在思考中
        </div>
      )}

      <div ref={endRef} className={styles.listEnd} aria-hidden />
    </div>
  )
}
