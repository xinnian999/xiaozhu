import { useCallback, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderKanban,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import { listVersions, type ApiVersion } from '@/lib/api'
import { toast } from '@/lib/toast'
import styles from './index.module.scss'

// ============================================
// 顶栏：项目与版本合并成一棵树
// - 一级节点选择项目，保留重命名 / 删除
// - 二级节点选择版本；旧版本沿用“回滚即生成新版本”的语义
// ============================================
export default function ProjectMenu() {
  const [open, setOpen] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [versionsBySession, setVersionsBySession] = useState<Record<string, ApiVersion[]>>({})
  const [loadingVersionIds, setLoadingVersionIds] = useState<Set<string>>(() => new Set())
  const [restoringId, setRestoringId] = useState<number | null>(null)
  // 正在内联重命名的会话 id（null 表示没有任何一项处于编辑态）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // 正在等待二次确认删除的会话 id
  const [confirmId, setConfirmId] = useState<string | null>(null)
  // 标记「这次 input 失焦是因为按了 Esc 取消」，让 onBlur 区分提交还是放弃
  const cancelRef = useRef(false)
  const loadingVersionIdsRef = useRef(new Set<string>())
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const activeSession = useSessionStore((s) => s.activeSession())
  const switchTo = useSessionStore((s) => s.switchTo)
  const goToEmpty = useSessionStore((s) => s.goToEmpty)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const rollbackToVersion = useSessionStore((s) => s.rollbackToVersion)

  // 关闭面板时一并清掉编辑/确认中间态，下次打开是干净的
  const close = useCallback(() => {
    setOpen(false)
    setEditingId(null)
    setConfirmId(null)
  }, [])
  useClickOutside(rootRef, close)

  const loadVersions = useCallback(async (sessionId: string) => {
    if (loadingVersionIdsRef.current.has(sessionId)) return
    loadingVersionIdsRef.current.add(sessionId)
    setLoadingVersionIds((current) => new Set(current).add(sessionId))
    try {
      const versions = await listVersions(sessionId)
      setVersionsBySession((current) => ({ ...current, [sessionId]: versions }))
    } finally {
      loadingVersionIdsRef.current.delete(sessionId)
      setLoadingVersionIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  const toggleOpen = () => {
    if (open) {
      close()
      return
    }
    setOpen(true)
    if (!activeId) return
    setExpandedIds((current) => new Set(current).add(activeId))
    void loadVersions(activeId)
  }

  const toggleProject = (id: string) => {
    const willExpand = !expandedIds.has(id)
    setExpandedIds((current) => {
      const next = new Set(current)
      if (willExpand) next.add(id)
      else next.delete(id)
      return next
    })
    if (willExpand) void loadVersions(id)
  }

  const handleSelect = async (id: string) => {
    await switchTo(id)
    close()
  }

  // 「新建项目」= 回到空态首屏（不立即建库），等用户发首条消息时再真正创建
  // 行为与首屏一致，避免出现空项目占位
  const handleCreate = async () => {
    await goToEmpty()
    close()
  }

  // ── 重命名 ───────────────────────────────────────────
  const startEdit = (id: string, title: string) => {
    setConfirmId(null) // 互斥：进入重命名就退出删除确认
    setEditingId(id)
    setEditValue(title)
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditValue('')
  }
  // 提交重命名（唯一收口在 onBlur）：空标题或没改动则放弃，否则调 store
  const commitRename = (id: string) => {
    const title = editValue.trim()
    const current = sessions.find((s) => s.id === id)
    cancelEdit()
    if (!title || title === current?.title) return
    void renameSession(id, title) // 失败由 axios 拦截器统一 toast，这里不阻塞 UI
  }

  // ── 删除 ─────────────────────────────────────────────
  const doDelete = (id: string) => {
    setConfirmId(null)
    void deleteSession(id)
  }

  const handleVersionSelect = async (
    sessionId: string,
    version: ApiVersion,
    isCurrent: boolean,
  ) => {
    if (isCurrent) {
      if (sessionId !== activeId) await switchTo(sessionId)
      close()
      return
    }

    setRestoringId(version.id)
    try {
      if (sessionId !== activeId) await switchTo(sessionId)
      await rollbackToVersion(version.id)
      toast(`已回滚到 v${version.seq}`)
      await loadVersions(sessionId)
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div className={styles.menu} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={toggleOpen}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {/* 没有激活项目时显示提示而不是「加载中…」—— 此时是用户刚进入空态首屏 */}
        <FolderKanban size={14} className={styles.projectIcon} aria-hidden />
        <span className={styles.projectName}>
          {activeSession?.title ?? (sessions.length > 0 ? '选择项目' : '尚无项目')}
        </span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="选择项目与版本">
          <p className={styles.panelTitle}>项目与版本</p>
          <ul className={styles.list} role="tree">
            {sessions.map((s) => {
              const expanded = expandedIds.has(s.id)
              const versions = versionsBySession[s.id] ?? []
              const loadingVersions = loadingVersionIds.has(s.id)

              return (
                <li key={s.id} className={styles.treeNode} role="treeitem" aria-expanded={expanded}>
                  {editingId === s.id ? (
                    // ── 内联重命名输入框 ──
                    <div className={styles.editWrap}>
                      <input
                        className={styles.editInput}
                        value={editValue}
                        autoFocus
                        maxLength={50}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur() // 回车=提交（触发 onBlur）
                          else if (e.key === 'Escape') {
                            cancelRef.current = true // 标记为取消，onBlur 据此放弃提交
                            e.currentTarget.blur()
                          }
                        }}
                        onBlur={() => {
                          if (cancelRef.current) {
                            cancelRef.current = false
                            cancelEdit()
                            return
                          }
                          commitRename(s.id)
                        }}
                      />
                    </div>
                  ) : confirmId === s.id ? (
                    // ── 删除二次确认 ──
                    <div className={styles.confirm}>
                      <span className={styles.confirmText}>删除「{s.title}」？</span>
                      <button
                        type="button"
                        className={styles.confirmYes}
                        onClick={() => doDelete(s.id)}
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        className={styles.confirmNo}
                        onClick={() => setConfirmId(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    // ── 一级项目节点：展开版本树 / 切换项目 / 项目操作 ──
                    <div
                      className={`${styles.item} ${s.id === activeId ? styles.itemActive : ''}`}
                    >
                      <button
                        type="button"
                        className={styles.expandBtn}
                        onClick={() => toggleProject(s.id)}
                        aria-label={expanded ? `收起「${s.title}」版本` : `展开「${s.title}」版本`}
                        aria-expanded={expanded}
                      >
                        <ChevronRight size={13} className={expanded ? styles.expandIconOpen : ''} />
                      </button>
                      <button
                        type="button"
                        className={styles.itemSelect}
                        onClick={() => void handleSelect(s.id)}
                      >
                        <Folder size={14} className={styles.itemIcon} aria-hidden />
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{s.title}</span>
                          <span className={styles.itemMeta}>{s.messages.length} 条消息</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        title="重命名"
                        aria-label={`重命名「${s.title}」`}
                        onClick={() => startEdit(s.id, s.title)}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className={`${styles.actionBtn} ${styles.actionDelete}`}
                        title={s.id === activeId ? '当前项目不能删除，请先切换项目' : '删除'}
                        aria-label={s.id === activeId ? '当前项目不能删除' : `删除「${s.title}」`}
                        disabled={s.id === activeId}
                        onClick={() => setConfirmId(s.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}

                  {expanded && editingId !== s.id && confirmId !== s.id && (
                    <ul className={styles.versionList} role="group">
                      {loadingVersions && versions.length === 0 ? (
                        <li className={styles.versionHint}>
                          <Loader2 size={12} className={styles.spin} aria-hidden />
                          加载版本…
                        </li>
                      ) : versions.length === 0 ? (
                        <li className={styles.versionHint}>暂无版本，生成一次即产生 v1</li>
                      ) : (
                        versions.map((version, index) => {
                          const isCurrent = index === 0
                          const busy = restoringId === version.id
                          return (
                            <li key={version.id} role="treeitem">
                              <button
                                type="button"
                                className={`${styles.versionItem} ${isCurrent ? styles.versionItemCurrent : ''}`}
                                disabled={restoringId !== null}
                                onClick={() => void handleVersionSelect(s.id, version, isCurrent)}
                                aria-label={
                                  isCurrent
                                    ? `选择「${s.title}」当前版本 v${version.seq}`
                                    : `回滚「${s.title}」到 v${version.seq}`
                                }
                              >
                                <span className={styles.versionTag}>v{version.seq}</span>
                                <span className={styles.versionMain}>
                                  <span className={styles.versionName}>
                                    {version.summary ?? '（无描述）'}
                                  </span>
                                  <span className={styles.versionMeta}>
                                    {formatTime(version.created_at)}
                                  </span>
                                </span>
                                <span className={isCurrent ? styles.currentBadge : styles.restoreBadge}>
                                  {isCurrent ? (
                                    <>
                                      <Check size={12} />
                                      当前
                                    </>
                                  ) : busy ? (
                                    <Loader2 size={12} className={styles.spin} />
                                  ) : (
                                    <>
                                      <RotateCcw size={12} />
                                      回滚
                                    </>
                                  )}
                                </span>
                              </button>
                            </li>
                          )
                        })
                      )}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          <button type="button" className={styles.createBtn} onClick={() => void handleCreate()}>
            <Plus size={14} />
            <span>新建项目</span>
          </button>
        </div>
      )}
    </div>
  )
}

// 相对时间：刚刚 / x 分钟前 / x 小时前 / 否则本地日期
function formatTime(iso: string): string {
  const time = new Date(iso).getTime()
  const diffMinutes = Math.floor((Date.now() - time) / 60000)
  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours} 小时前`
  return new Date(time).toLocaleDateString()
}
