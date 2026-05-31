import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, History, RotateCcw, Loader2, Check } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import { listVersions, type ApiVersion } from '@/lib/api'
import { toast } from '@/lib/toast'
import styles from './index.module.scss'

// ============================================
// 顶栏：版本历史下拉（单线递增模型）
// - 打开面板时拉取该会话的版本列表（后端按 seq 倒序，最新在前）
// - 列表第一项（seq 最大）即当前 tip，标「当前」
// - 点旧版本「回滚」：后端用快照覆盖当前文件并 append 一个新版本，
//   前端用返回的文件 replaceFiles → PreviewPane 增量同步进 WebContainer
// ============================================
export default function VersionMenu() {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<ApiVersion[]>([])
  const [loading, setLoading] = useState(false)
  // 正在回滚的版本 id，用于行内 loading + 期间禁用其他回滚按钮
  const [restoringId, setRestoringId] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const activeId = useSessionStore((s) => s.activeId)
  const rollbackToVersion = useSessionStore((s) => s.rollbackToVersion)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  // 拉取版本列表
  const refresh = useCallback(async () => {
    if (!activeId) return
    setLoading(true)
    try {
      setVersions(await listVersions(activeId))
    } finally {
      setLoading(false)
    }
  }, [activeId])

  // 每次打开面板刷新一次，保证看到最新（生成 / 回滚都会新增版本）
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // 没有激活会话就不渲染 —— 没有项目就没有版本概念
  if (!activeId) return null

  const handleRestore = async (v: ApiVersion) => {
    setRestoringId(v.id)
    try {
      // rollbackToVersion 内部完成：覆盖文件 + append 新版本 + 追加版本卡
      await rollbackToVersion(v.id)
      toast(`已回滚到 v${v.seq}`)
      await refresh() // 回滚会 append 新版本，刷新列表
    } finally {
      setRestoringId(null)
    }
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
        <History size={14} className={styles.triggerIcon} />
        <span className={styles.label}>版本历史</span>
        <ChevronDown size={13} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="版本历史">
          <p className={styles.panelTitle}>版本历史</p>
          <p className={styles.panelDesc}>单线递增，回滚即生成新版本</p>

          {loading && versions.length === 0 ? (
            <p className={styles.hint}>加载中…</p>
          ) : versions.length === 0 ? (
            <p className={styles.hint}>暂无版本，生成一次即产生 v1</p>
          ) : (
            <ul className={styles.list}>
              {versions.map((v, i) => {
                const isCurrent = i === 0 // 最新（seq 最大）= 当前 tip
                const busy = restoringId === v.id
                return (
                  <li
                    key={v.id}
                    className={`${styles.item} ${isCurrent ? styles.itemCurrent : ''}`}
                  >
                    <span className={styles.versionTag}>v{v.seq}</span>
                    <span className={styles.itemMain}>
                      <span className={styles.itemName}>{v.summary ?? '（无描述）'}</span>
                      <span className={styles.itemMeta}>{formatTime(v.created_at)}</span>
                    </span>
                    {isCurrent ? (
                      <span className={styles.currentBadge}>
                        <Check size={13} />
                        当前
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.restoreBtn}
                        disabled={restoringId !== null}
                        onClick={() => handleRestore(v)}
                        aria-label={`回滚到 v${v.seq}`}
                      >
                        {busy ? (
                          <Loader2 size={13} className={styles.spin} />
                        ) : (
                          <RotateCcw size={13} />
                        )}
                        <span>回滚</span>
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// 相对时间：刚刚 / x 分钟前 / x 小时前 / 否则本地日期
function formatTime(iso: string): string {
  const t = new Date(iso).getTime()
  const diffMin = Math.floor((Date.now() - t) / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} 小时前`
  return new Date(t).toLocaleDateString()
}
