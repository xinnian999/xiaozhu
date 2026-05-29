import { useState } from 'react'
import { ArrowUp, Mic, Paperclip, Image as ImageIcon, X } from 'lucide-react'
import { useSessionStore, makeMessage } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { streamChat } from '@/lib/api'
import { toast } from '@/lib/toast'
import MessageList from './MessageList'
import styles from './index.module.scss'

// ============================================
// 左侧聊天侧栏
// ============================================
export default function ChatSidebar() {
  const session = useSessionStore((s) => s.activeSession())
  const appendMessage = useSessionStore((s) => s.appendMessage)
  const setStreamingText = useSessionStore((s) => s.setStreamingText)
  const commitStreaming = useSessionStore((s) => s.commitStreaming)
  const mobileChatOpen = useUIStore((s) => s.mobileChatOpen)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)

  const [draft, setDraft] = useState('')

  const isStreaming = session?.isStreaming ?? false

  const handleSend = async () => {
    if (!draft.trim() || isStreaming || !session) return

    const text = draft.trim()
    setDraft('')

    // 1. 把用户消息追加到列表
    appendMessage(makeMessage('user', text))

    // 2. 流式消费 SSE，逐 token 累积到 streamingText
    let accumulated = ''
    try {
      for await (const event of streamChat(text, session.id)) {
        if (event.type === 'message_delta') {
          accumulated += event.text
          setStreamingText(accumulated)
        } else if (event.type === 'error') {
          toast(`AI 错误：${event.message}`)
          break
        } else if (event.type === 'done') {
          break
        }
      }
    } finally {
      // 3. 无论成功还是出错，都把累积内容固化为一条 assistant 消息
      commitStreaming()
    }
  }

  return (
    <>
      {mobileChatOpen && (
        <div
          className={styles.scrim}
          onClick={() => setMobileChatOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`${styles.sidebar} ${mobileChatOpen ? styles.mobileOpen : ''} ${chatCollapsed ? styles.collapsed : ''}`}
        aria-label="对话"
      >
        <button
          className={styles.mobileClose}
          onClick={() => setMobileChatOpen(false)}
          aria-label="关闭侧栏"
        >
          <X size={16} />
        </button>

        <div className={styles.chatBody}>
          <MessageList />
        </div>

        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            <textarea
              className={styles.input}
              placeholder={isStreaming ? 'AI 正在回复…' : '描述你想要的应用…'}
              value={draft}
              disabled={isStreaming}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
            />

            <div className={styles.composerActions}>
              <div className={styles.composerTools}>
                <button className={styles.toolBtn} aria-label="附件">
                  <Paperclip size={14} />
                </button>
                <button className={styles.toolBtn} aria-label="图片">
                  <ImageIcon size={14} />
                </button>
                <button className={styles.toolBtn} aria-label="语音">
                  <Mic size={14} />
                </button>
              </div>

              <button
                className={`${styles.sendBtn} ${draft.trim() && !isStreaming ? styles.sendActive : ''}`}
                onClick={handleSend}
                disabled={isStreaming}
                aria-label="发送"
              >
                <ArrowUp size={14} />
              </button>
            </div>
          </div>

          <div className={styles.composerHint}>
            <span>Shift + Enter 换行</span>
          </div>
        </footer>
      </aside>
    </>
  )
}
