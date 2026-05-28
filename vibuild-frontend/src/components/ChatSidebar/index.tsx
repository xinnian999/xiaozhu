import { useState } from 'react'
import { ArrowUp, Mic, Paperclip, Image as ImageIcon, X } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { formatDuration, formatClock } from '@/lib/format'
import VersionCard from './VersionCard'
import styles from './index.module.scss'

// ============================================
// 左侧聊天/版本侧栏
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
    pushToast('对话功能将在后端接入后开放')
    setDraft('')
  }

  return (
    <>
      {/* 移动端遮罩 */}
      {mobileChatOpen && (
        <div
          className={styles.scrim}
          onClick={() => setMobileChatOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`${styles.sidebar} ${mobileChatOpen ? styles.mobileOpen : ''} ${chatCollapsed ? styles.collapsed : ''}`}
        aria-label="对话与版本"
      >
        {/* 移动端关闭按钮 */}
        <button
          className={styles.mobileClose}
          onClick={() => setMobileChatOpen(false)}
          aria-label="关闭侧栏"
        >
          <X size={16} />
        </button>

        {/* 顶部说明：项目派生信息 */}
        <header className={styles.header}>
          <div className={styles.headerMeta}>
            <span className={styles.metaLabel}>会话</span>
            <span className={styles.metaDot} aria-hidden />
            <span className={styles.metaTime}>{formatClock(Date.now())}</span>
          </div>

          {session.duplicatedFrom && (
            <p className={styles.derived}>
              <span className={styles.derivedName}>{session.name}</span>
              <span className={styles.derivedFrom}> 派生自 </span>
              <a className={styles.derivedLink}>
                {session.duplicatedFrom}
                <span className={styles.linkArrow} aria-hidden>↗</span>
              </a>
            </p>
          )}

          <p className={styles.tip}>继续对话以提问或修改这个项目。</p>
        </header>

        {/* 版本卡片列表（按时间倒序） */}
        <div className={styles.versions}>
          {[...session.versions].reverse().map((v) => (
            <VersionCard
              key={v.id}
              version={v}
              isCurrent={v.id === session.currentVersionId}
              projectName={session.name}
            />
          ))}
        </div>

        {/* 工作时长统计 */}
        <div className={styles.stats}>
          <div className={styles.statLine}>
            <span className={styles.statBar} aria-hidden>
              <i style={{ width: '62%' }} />
            </span>
            <span className={styles.statText}>
              已工作 <strong>{formatDuration(session.workedSeconds)}</strong>
            </span>
            <span className={styles.statClock}>{formatClock(Date.now())}</span>
          </div>
        </div>

        {/* 输入框 */}
        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            <textarea
              className={styles.input}
              placeholder="继续描述你的需求…"
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
