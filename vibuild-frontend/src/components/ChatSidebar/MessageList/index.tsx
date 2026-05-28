import { useEffect, useMemo, useRef } from 'react'
import { MessageSquare } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useEditorStore } from '@/store/editor'
import { getMessagesForVersion } from '@/lib/sessionBranch'
import MessageBubble from '../MessageBubble'
import styles from './index.module.scss'

// ============================================
// 对话列表：按当前选中版本裁剪并渲染 session 消息
// ============================================
export default function MessageList() {
  const session = useSessionStore((s) => s.session)
  const setCurrentVersion = useSessionStore((s) => s.setCurrentVersion)
  const resetEditor = useEditorStore((s) => s.reset)
  const endRef = useRef<HTMLDivElement>(null)

  const messages = useMemo(
    () => getMessagesForVersion(session, session.currentVersionId),
    [session.id, session.currentVersionId, session.messages, session.versions],
  )

  const versionById = useMemo(
    () => new Map(session.versions.map((v) => [v.id, v])),
    [session.versions],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, session.currentVersionId, session.id])

  const handleVersionClick = (versionId: string) => {
    if (versionId === session.currentVersionId) return
    setCurrentVersion(versionId)
    resetEditor()
  }

  if (messages.length === 0) {
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
        <MessageBubble
          key={msg.id}
          message={msg}
          producedVersion={
            msg.producedVersionId ? versionById.get(msg.producedVersionId) : undefined
          }
          isVersionCurrent={msg.producedVersionId === session.currentVersionId}
          onVersionClick={handleVersionClick}
        />
      ))}
      <div ref={endRef} className={styles.listEnd} aria-hidden />
    </div>
  )
}
