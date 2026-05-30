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
  const activeId = useSessionStore((s) => s.activeId)
  const createNew = useSessionStore((s) => s.createNew)
  const appendMessage = useSessionStore((s) => s.appendMessage)
  const setStreamingText = useSessionStore((s) => s.setStreamingText)
  const commitStreaming = useSessionStore((s) => s.commitStreaming)
  const applyFileWrite = useSessionStore((s) => s.applyFileWrite)
  const applyFileDelete = useSessionStore((s) => s.applyFileDelete)
  const mobileChatOpen = useUIStore((s) => s.mobileChatOpen)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)

  const [draft, setDraft] = useState('')
  // 首条消息自动建会话期间禁用输入，避免重复点
  const [creating, setCreating] = useState(false)

  const isStreaming = session?.isStreaming ?? false
  // 无激活会话时，侧栏切换到"全屏空态"布局
  const noSession = activeId === null

  const handleSend = async () => {
    if (!draft.trim() || isStreaming || creating) return

    const text = draft.trim()
    setDraft('')

    // 无激活会话：用首条消息的前缀当标题，先建一个会话再发
    let targetSessionId = session?.id
    if (!targetSessionId) {
      setCreating(true)
      try {
        const newSession = await createNew(text.slice(0, 20))
        targetSessionId = newSession.id
      } catch {
        setCreating(false)
        return
      }
      setCreating(false)
    }

    // 1. 把用户消息追加到列表
    appendMessage(makeMessage('user', text))

    // 2. 流式消费 SSE，逐 token 累积到 streamingText
    let accumulated = ''
    try {
      for await (const event of streamChat(text, targetSessionId)) {
        if (event.type === 'message_delta') {
          accumulated += event.text
          setStreamingText(accumulated)
        } else if (event.type === 'file_write') {
          // LLM 写文件 —— 更新本地 files 快照，PreviewPane 会自动 syncFiles
          applyFileWrite(event.path, event.content)
        } else if (event.type === 'file_delete') {
          applyFileDelete(event.path)
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

  const composerDisabled = isStreaming || creating
  const placeholder = creating
    ? '正在创建会话…'
    : isStreaming
      ? 'AI 正在回复…'
      : noSession
        ? '描述你想要的应用，我来为你生成…'
        : '继续聊聊还想加点什么…'

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
        className={`${styles.sidebar} ${mobileChatOpen ? styles.mobileOpen : ''} ${chatCollapsed ? styles.collapsed : ''} ${noSession ? styles.fullscreen : ''}`}
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
          {noSession ? <EmptyHero /> : <MessageList />}
        </div>

        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            <textarea
              className={styles.input}
              placeholder={placeholder}
              value={draft}
              disabled={composerDisabled}
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
                className={`${styles.sendBtn} ${draft.trim() && !composerDisabled ? styles.sendActive : ''}`}
                onClick={handleSend}
                disabled={composerDisabled}
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

// ============================================
// 空态欢迎区：没有激活会话时的引导文案
// ============================================
function EmptyHero() {
  return (
    <div className={styles.hero}>
      <h1 className={styles.heroTitle}>开始构建你的应用</h1>
      <p className={styles.heroSubtitle}>
        在下方输入一句话需求，我会立刻为你生成一个可运行的前端项目
      </p>
    </div>
  )
}
