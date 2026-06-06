import { useEffect, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import MessageBubble from '../MessageBubble'
import styles from './index.module.scss'

// 首次进入会话时，等右侧预览区的 fade-up 展开动画（0.6s）放完、布局稳定后再滚到底。
// 否则在动画/布局还没稳的时候滚，会滚不到最底。留一点余量取 700ms。
const INIT_SCROLL_DELAY = 700

// ============================================
// 对话列表：渲染当前会话消息 + 流式输出中的 AI 消息
// ============================================
export default function MessageList() {
  const session = useSessionStore((s) => s.activeSession())
  const endRef = useRef<HTMLDivElement>(null)
  // 记录已经为哪个会话做过「首次定位到底部」。首次（刷新 / 切会话）延时滚，
  // 避开预览区展开动画 + 布局抖动；之后的新消息才即时 smooth 平滑滚动。
  const didInitScrollRef = useRef<string | null>(null)

  const messages = session?.messages ?? []
  const isStreaming = session?.isStreaming ?? false
  const sessionId = session?.id ?? null

  // 新消息到来 / 进入思考态时滚动到底部
  useEffect(() => {
    if (!endRef.current) return
    const isFirst = didInitScrollRef.current !== sessionId
    if (isFirst) {
      // 首次：占位标记先打上，避免这 700ms 内的重渲染又走进首次分支；
      // 等展开动画 + 布局稳定后再瞬时定位到底。
      didInitScrollRef.current = sessionId
      const timer = setTimeout(() => {
        endRef.current?.scrollIntoView({ behavior: 'auto' })
      }, INIT_SCROLL_DELAY)
      // 清理：会话在延时内被切走 / 组件卸载，撤掉这次滚动，免得滚错会话
      return () => clearTimeout(timer)
    }
    // 同会话后续更新：即时平滑滚动
    endRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [sessionId, messages.length, isStreaming])

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className={styles.empty}>
        <MessageSquare size={20} className={styles.emptyIcon} />
        <p className={styles.emptyTitle}>还没有对话</p>
        <p className={styles.emptyHint}>在下方输入需求，开始生成第一个版本</p>
      </div>
    )
  }

  // 只在「最后一条文本消息」下方显示时间，作为这轮对话结束的标记。
  // 从后往前找第一条文本消息（跳过工具卡 / 版本卡 —— 它们本就不显示时间，
  // 否则末尾跟着一张版本卡时会导致整段对话都不显示时间）。
  let lastTextIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const k = messages[i].kind
    if (!k || k === 'text') {
      lastTextIndex = i
      break
    }
  }

  return (
    <div className={styles.list}>
      {messages.map((msg, i) => (
        <MessageBubble key={msg.id} message={msg} isLast={i === lastTextIndex} />
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
