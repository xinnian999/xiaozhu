import { useEffect, useRef, useState } from 'react'
import { X, Trash2, Server, Globe } from 'lucide-react'
import { useUIStore, type LogEntry } from '@/store/ui'
import NodeTerminal from './NodeTerminal'
import styles from './index.module.scss'

// 拖拽时高度的钳制范围
const MIN_HEIGHT = 120
// 至少给上面的 TabBar + 一截预览留出 160px
const MAX_HEIGHT_PADDING = 160

type TabKey = 'browser' | 'node'

// ============================================
// 控制台面板：底部抽屉
// - Node 进程 tab：交给 xterm.js 渲染（NodeTerminal）
// - 浏览器 tab：浏览器 console 是结构化数据，仍用我们的列表 UI
// - 顶部 4px 拖拽条可调整面板高度
// - 即使切到浏览器 tab，NodeTerminal 也保持挂载（display:none 隐藏），
//   否则 xterm 实例销毁会丢失历史输出 —— 上层不能用条件渲染换掉它
// ============================================
export default function ConsolePanel() {
  const open = useUIStore((s) => s.consoleOpen)
  const setOpen = useUIStore((s) => s.setConsoleOpen)
  const height = useUIStore((s) => s.consoleHeight)
  const setHeight = useUIStore((s) => s.setConsoleHeight)
  const logs = useUIStore((s) => s.wcLogs)
  const clear = useUIStore((s) => s.clearWcLogs)

  const [tab, setTab] = useState<TabKey>('browser')
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // ── 拖拽调整高度 ──
  // 用 Pointer Capture，避免 iframe 偷走 pointerup
  useEffect(() => {
    if (!dragging) return
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
    return () => {
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = ''
    }
  }, [dragging])

  const onResizerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = { startY: e.clientY, startHeight: height }
    setDragging(true)
  }

  const onResizerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragStateRef.current
    if (!s) return
    const next = s.startHeight + (s.startY - e.clientY)
    const max = window.innerHeight - MAX_HEIGHT_PADDING
    const clamped = Math.max(MIN_HEIGHT, Math.min(max, next))
    setHeight(clamped)
  }

  const onResizerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    dragStateRef.current = null
    setDragging(false)
  }

  if (!open) return null

  return (
    <div
      className={styles.panel}
      role="region"
      aria-label="控制台"
      style={{ height }}
    >
      <div
        className={`${styles.resizer} ${dragging ? styles.resizerActive : ''}`}
        onPointerDown={onResizerPointerDown}
        onPointerMove={onResizerPointerMove}
        onPointerUp={onResizerPointerUp}
        onPointerCancel={onResizerPointerUp}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整控制台高度"
      />

      <div className={styles.header}>
        <div className={styles.tabs}>
          <FilterTab
            label="浏览器"
            icon={<Globe size={11} />}
            count={logs.length}
            active={tab === 'browser'}
            onClick={() => setTab('browser')}
          />
          <FilterTab
            label="Node 进程"
            icon={<Server size={11} />}
            active={tab === 'node'}
            onClick={() => setTab('node')}
          />
        </div>

        <div className={styles.actions}>
          {tab === 'browser' && (
            <button
              className={styles.iconBtn}
              onClick={clear}
              aria-label="清空"
              title="清空"
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            className={styles.iconBtn}
            onClick={() => setOpen(false)}
            aria-label="关闭控制台"
            title="关闭"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {/* xterm 实例必须常驻 —— 切走 tab 时只 display:none，不能 unmount */}
        <div style={{ display: tab === 'node' ? 'block' : 'none', height: '100%' }}>
          <NodeTerminal />
        </div>
        <div style={{ display: tab === 'browser' ? 'block' : 'none', height: '100%' }}>
          <BrowserLogs logs={logs} />
        </div>
      </div>
    </div>
  )
}

// ============================================
// 浏览器 console 日志列表
// ============================================
function BrowserLogs({ logs }: { logs: LogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  useEffect(() => {
    if (!followRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logs.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16
  }

  return (
    <div ref={scrollRef} className={styles.logList} onScroll={onScroll}>
      {logs.length === 0 ? (
        <p className={styles.empty}>暂无日志</p>
      ) : (
        logs.map((log) => <LogRow key={log.id} log={log} />)
      )}
    </div>
  )
}

// ── 单行日志 ───────────────────────────────────────────────────
function LogRow({ log }: { log: LogEntry }) {
  return (
    <div className={`${styles.row} ${styles[`row_${log.level}`]}`}>
      <pre className={styles.rowText}>{log.text}</pre>
    </div>
  )
}

// ── 过滤 Tab ───────────────────────────────────────────────────
function FilterTab({
  label,
  count,
  active,
  icon,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  icon?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`${styles.tab} ${active ? styles.tabActive : ''}`}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && <span className={styles.tabCount}>{count}</span>}
    </button>
  )
}
