import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Plus,
  FolderKanban,
  Pencil,
  Trash2,
  Search,
  LoaderCircle,
} from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { getActiveGenerationIds } from '@/lib/api'
import { useClickOutside } from '@/hooks/useClickOutside'
import styles from './index.module.scss'

const PROJECT_PAGE_SIZE = 20
const GENERATION_STATUS_POLL_MS = 2000

// ============================================
// 顶栏：项目切换下拉（支持重命名 / 删除）
// ============================================
export default function ProjectMenu() {
  const [open, setOpen] = useState(false)
  // 正在内联重命名的会话 id（null 表示没有任何一项处于编辑态）
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // 正在等待二次确认删除的会话 id
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 项目较多时分批渲染；滚动到列表底部附近再追加下一批，避免菜单首次打开过重。
  const [visibleCount, setVisibleCount] = useState(PROJECT_PAGE_SIZE)
  // 菜单需要同时展示其它项目的后台任务，不能只依赖当前页面的 isStreaming。
  const [activeGenerationIds, setActiveGenerationIds] = useState<Set<string>>(new Set())
  // 标记「这次 input 失焦是因为按了 Esc 取消」，让 onBlur 区分提交还是放弃
  const cancelRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const activeSession = useSessionStore((s) => s.activeSession())
  const switchTo = useSessionStore((s) => s.switchTo)
  const goToEmpty = useSessionStore((s) => s.goToEmpty)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredSessions = useMemo(
    () => sessions.filter((session) => (
      session.title.toLocaleLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, sessions],
  )
  const visibleSessions = filteredSessions.slice(0, visibleCount)
  const hasMore = visibleSessions.length < filteredSessions.length

  // 关闭面板时一并清掉搜索、编辑和确认中间态，下次打开是干净的。
  const close = useCallback(() => {
    setOpen(false)
    setEditingId(null)
    setConfirmId(null)
    setQuery('')
    setVisibleCount(PROJECT_PAGE_SIZE)
  }, [])
  useClickOutside(rootRef, close)

  // 仅在菜单展开时轮询；关闭后立即停止，避免常驻请求。当前项目的本地 isStreaming
  // 会在请求返回前即时兜底，因此刚点击发送再打开菜单也不会短暂显示成空闲。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const syncGenerationStates = async () => {
      try {
        const ids = await getActiveGenerationIds()
        if (!cancelled) setActiveGenerationIds(new Set(ids))
      } catch (error) {
        // 状态提示是增强信息；短暂网络失败时保留上一份结果，不影响项目切换。
        console.warn('同步项目生成状态失败', error)
      }
    }
    void syncGenerationStates()
    const timer = window.setInterval(syncGenerationStates, GENERATION_STATUS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open])

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

  return (
    <div className={styles.menu} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
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
        <div className={styles.panel} role="menu" aria-label="选择项目">
          <div className={styles.panelHeader}>
            <p className={styles.panelTitle}>项目</p>
            <span>{sessions.length}</span>
          </div>
          {sessions.length > 8 && (
            <label className={styles.search}>
              <Search size={13} aria-hidden />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setVisibleCount(PROJECT_PAGE_SIZE)
                }}
                placeholder="搜索项目"
                aria-label="搜索项目"
              />
            </label>
          )}
          <ul
            className={styles.list}
            onScroll={(event) => {
              if (!hasMore) return
              const list = event.currentTarget
              const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight
              if (distanceToBottom <= 48) {
                setVisibleCount((count) => (
                  Math.min(count + PROJECT_PAGE_SIZE, filteredSessions.length)
                ))
              }
            }}
          >
            {visibleSessions.map((s) => {
              const userRounds = s.messages.filter((message) => message.role === 'user').length
              const isGenerating = s.isStreaming || activeGenerationIds.has(s.id)
              return (
                <li key={s.id}>
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
                  // ── 普通行：选择 + 重命名 + 删除 ──
                  <div
                    className={`${styles.item} ${s.id === activeId ? styles.itemActive : ''}`}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.itemSelect}
                      onClick={() => void handleSelect(s.id)}
                    >
                      <span className={styles.itemMain}>
                        <span className={styles.itemName}>{s.title}</span>
                        <span
                          className={`${styles.itemMeta} ${isGenerating ? styles.itemMetaLoading : ''}`}
                          aria-label={isGenerating ? '项目正在生成' : undefined}
                        >
                          {isGenerating ? (
                            <>
                              <LoaderCircle className={styles.loadingIcon} size={11} aria-hidden />
                              <span>生成中</span>
                            </>
                          ) : (
                            userRounds > 0 ? `${userRounds} 轮对话` : '未开始'
                          )}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.actionBtn}
                      title="重命名"
                      aria-label="重命名"
                      onClick={() => startEdit(s.id, s.title)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.actionDelete}`}
                      title={s.id === activeId ? '当前项目不能删除，请先切换项目' : '删除'}
                      aria-label={s.id === activeId ? '当前项目不能删除' : '删除'}
                      disabled={s.id === activeId}
                      onClick={() => setConfirmId(s.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </li>
              )
            })}
          </ul>
          {visibleSessions.length === 0 && (
            <p className={styles.empty}>没有找到匹配的项目</p>
          )}
          <button type="button" className={styles.createBtn} onClick={() => void handleCreate()}>
            <Plus size={14} />
            <span>新建项目</span>
          </button>
        </div>
      )}
    </div>
  )
}
