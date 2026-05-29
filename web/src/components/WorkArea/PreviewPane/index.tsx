import { useEffect, useRef } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore, type WCStatus } from '@/store/ui'
import { bootAndRun, syncFiles, isBooted, isDevRunning } from '@/lib/webcontainer'
import styles from './index.module.scss'

// ============================================
// 预览面板：WebContainer 真实预览
// - 首次进入 tab 才 boot（降低首屏开销）
// - boot 成功后 iframe 加载 vite dev server URL
// - 切版本时增量 syncFiles，依赖 vite HMR 自动刷新
// - 失败时回落到拟态占位（保留原视觉作为背景）
// ============================================
export default function PreviewPane() {
  const currentVersion = useSessionStore((s) => s.currentVersion())

  const wcStatus = useUIStore((s) => s.wcStatus)
  const wcUrl = useUIStore((s) => s.wcUrl)
  const wcLog = useUIStore((s) => s.wcLog)
  const wcError = useUIStore((s) => s.wcError)
  const setWCStatus = useUIStore((s) => s.setWCStatus)
  const setWCUrl = useUIStore((s) => s.setWCUrl)
  const setWCLog = useUIStore((s) => s.setWCLog)
  const setWCError = useUIStore((s) => s.setWCError)

  // 标记上次同步的版本号，避免同 version 反复 sync
  const syncedVersionRef = useRef<string | null>(null)

  // —— 首次启动：等 files 到位再 boot ——
  // files 从后端拉取是异步的，组件挂载时 currentVersion.files 可能还是空对象，
  // 此时 boot 会让 WebContainer 找不到 package.json 直接报 ENOENT。
  // 改成监听 files 变化，第一次出现非空 files 时再 boot。
  useEffect(() => {
    if (isBooted()) return
    if (Object.keys(currentVersion.files).length === 0) return  // 还没拉到文件，等

    setWCError(null)
    bootAndRun(currentVersion.files, {
      onStatus: setWCStatus,
      onUrl: setWCUrl,
      onLog: setWCLog,
      onError: setWCError,
    }).then(() => {
      syncedVersionRef.current = currentVersion.id
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion.files])

  // —— 切版本：增量同步 ——
  useEffect(() => {
    if (!isDevRunning()) return
    if (syncedVersionRef.current === currentVersion.id) return

    setWCStatus('syncing')
    syncFiles(currentVersion.files, { onLog: setWCLog })
      .then(() => {
        syncedVersionRef.current = currentVersion.id
        setWCStatus('ready')
      })
      .catch((e) => {
        setWCError(e instanceof Error ? e.message : String(e))
        setWCStatus('error')
      })
  }, [currentVersion.id, currentVersion.files, setWCStatus, setWCLog, setWCError])

  const showIframe = wcUrl && (wcStatus === 'ready' || wcStatus === 'syncing')
  const isErrored = wcStatus === 'error'

  return (
    <div className={styles.preview}>
      <div className={styles.bgGrid} aria-hidden />
      <div className={styles.bgGlow} aria-hidden />

      <div className={styles.frame}>
        <div className={styles.browser}>
          <div className={styles.browserBar}>
            <span className={styles.dots} aria-hidden>
              <i /><i /><i />
            </span>
            <span className={styles.browserUrl}>
              {wcUrl ? new URL(wcUrl).host : 'localhost:5173'}
            </span>
            <StatusBadge status={wcStatus} />
          </div>

          <div className={styles.viewport}>
            {showIframe && (
              <iframe
                src={wcUrl!}
                className={styles.iframe}
                title="预览"
                allow="cross-origin-isolated"
              />
            )}

            {/* 未 ready：覆盖一层 loader / 错误 / 拟态占位 */}
            {!showIframe && (
              <div className={styles.overlay}>
                {isErrored ? (
                  <ErrorBlock error={wcError} />
                ) : (
                  <BootingBlock status={wcStatus} log={wcLog} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// 状态徽章：浏览器条上的小圆点 + 文字
// ============================================
function StatusBadge({ status }: { status: WCStatus }) {
  const label = STATUS_LABELS[status]
  return (
    <span className={`${styles.statusBadge} ${styles[`statusBadge_${status}`]}`}>
      <i className={styles.statusDot} />
      {label}
    </span>
  )
}

// ============================================
// boot/install/start 进行时的 overlay
// ============================================
function BootingBlock({ status, log }: { status: WCStatus; log: string }) {
  const steps: { key: WCStatus; label: string }[] = [
    { key: 'booting', label: '启动运行时' },
    { key: 'mounting', label: '挂载文件' },
    { key: 'installing', label: '安装依赖' },
    { key: 'starting', label: '启动开发服务' },
  ]
  const idx = steps.findIndex((s) => s.key === status)

  return (
    <div className={styles.booting}>
      <Loader2 size={20} className={styles.spinner} />
      <h3>正在启动预览</h3>
      <ol className={styles.steps}>
        {steps.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'active' : 'pending'
          return (
            <li key={s.key} className={styles[`step_${state}`]}>
              <span className={styles.stepDot} />
              <span className={styles.stepLabel}>{s.label}</span>
            </li>
          )
        })}
      </ol>
      {log && <pre className={styles.bootLog}>{log}</pre>}
    </div>
  )
}

// ============================================
// 错误态
// ============================================
function ErrorBlock({ error }: { error: string | null }) {
  return (
    <div className={styles.errBlock}>
      <AlertTriangle size={20} />
      <h3>启动失败</h3>
      <p>{error ?? '未知错误'}</p>
      <p className={styles.errHint}>
        请刷新页面重试。WebContainer 仅支持现代浏览器并需要 COOP/COEP 头。
      </p>
    </div>
  )
}

const STATUS_LABELS: Record<WCStatus, string> = {
  idle: '未启动',
  booting: '启动中',
  mounting: '挂载中',
  installing: '安装中',
  starting: '启动中',
  ready: '运行中',
  syncing: '同步中',
  error: '失败',
}
