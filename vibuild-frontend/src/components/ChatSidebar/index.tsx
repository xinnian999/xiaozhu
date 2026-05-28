import { useState } from 'react'
import { ArrowUp, Mic, Paperclip, Image as ImageIcon, X } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { willForkOnContinue } from '@/lib/sessionBranch'
import MessageList from './MessageList'
import styles from './index.module.scss'

// ============================================
// 左侧聊天侧栏
// ============================================
export default function ChatSidebar() {
  const session = useSessionStore((s) => s.session)
  const mobileChatOpen = useUIStore((s) => s.mobileChatOpen)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)
  const pushToast = useUIStore((s) => s.pushToast)

  const [draft, setDraft] = useState('')

  const handleSend = () => {
    if (!draft.trim()) return
    if (willForkOnContinue(session, session.currentVersionId)) {
      pushToast('将在此版本上创建新分支继续对话，原有后续版本仍可在顶栏找回')
    } else {
      pushToast('对话功能将在后端接入后开放')
    }
    setDraft('')
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
              placeholder={
                willForkOnContinue(session, session.currentVersionId)
                  ? '从当前版本创建新分支并继续…'
                  : '继续描述你的需求…'
              }
              value={draft}
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
                className={`${styles.sendBtn} ${draft.trim() ? styles.sendActive : ''}`}
                onClick={handleSend}
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
