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
  const streamingText = session?.streamingText ?? ''
  const isStreaming = session?.isStreaming ?? false

  // 新消息到来时滚动到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streamingText])

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

      {/* 流式输出中的 AI 消息：单独渲染，末尾加光标动画 */}
      {isStreaming && (
        <MessageBubble
          message={{
            id: 'streaming',
            role: 'assistant',
            text: streamingText,
            createdAt: Date.now(),
            branchId: 'main',
          }}
          isStreaming
        />
      )}

      <div ref={endRef} className={styles.listEnd} aria-hidden />
    </div>
  )
}
