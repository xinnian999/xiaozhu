import { useEffect, useRef } from 'react'
import { Loader2, AlertTriangle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore, type WCStatus, type LogLevel } from '@/store/ui'
import { bootAndRun, syncFiles, resetContainer, isBooted, isDevRunning } from '@/lib/webcontainer'
import { pushLogs, type PushLog } from '@/lib/api'
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
  // 当前会话 id —— 回传日志要带上它，后端按 session 分桶存
  const activeId = useSessionStore((s) => s.activeId)

  const wcStatus = useUIStore((s) => s.wcStatus)
  const wcUrl = useUIStore((s) => s.wcUrl)
  const wcLog = useUIStore((s) => s.wcLog)
  const wcError = useUIStore((s) => s.wcError)
  const setWCStatus = useUIStore((s) => s.setWCStatus)
  const setWCUrl = useUIStore((s) => s.setWCUrl)
  const setWCLog = useUIStore((s) => s.setWCLog)
  const setWCError = useUIStore((s) => s.setWCError)
  const pushWcLog = useUIStore((s) => s.pushWcLog)
  // 清空浏览器 console 日志面板 —— 切会话重挂时一并清掉
  const clearWcLogs = useUIStore((s) => s.clearWcLogs)
  // 刷新计数器：变化即触发 iframe 重新挂载
  const reloadTick = useUIStore((s) => s.previewReloadTick)

  // 标记上次同步的版本号，避免同 version 反复 sync
  const syncedVersionRef = useRef<string | null>(null)
  // 容器当前归属哪个会话 —— 用来判断 activeId 变了要不要 teardown 重挂
  const containerSessionRef = useRef<string | null>(null)
  // 当前 iframe 的引用，用于校验 postMessage 来源
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // —— 日志回传给后端 ——
  // activeId 放进 ref：下面的回调/定时器是在 effect 里建的闭包，
  // 直接读 activeId 会捕获到旧值，用 ref 保证拿到最新会话 id。
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  // 待回传的日志缓冲 + debounce 定时器：日志是高频的（HMR 重连一刷一片），
  // 攒一小批一起发，别一条一个请求。
  const pendingLogsRef = useRef<PushLog[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // —— 容器生命周期：让运行中的容器始终对应当前会话 ——
  // 首次启动、以及「切会话 / 开新会话」都走这里。切到不同会话时先 teardown
  // 旧容器再重新 boot+mount —— FS / dev server / 终端日志全部从零开始，绝不串台
  // （WebContainer 同一时刻只能有一个实例）。
  //
  // 等 files 到位再启动：files 从后端异步拉取，切换瞬间新会话的 files 还是空对象，
  // 此时 boot 会让 WebContainer 找不到 package.json 直接 ENOENT。
  useEffect(() => {
    if (Object.keys(currentVersion.files).length === 0) return  // 还没拉到文件，等

    const prevSession = containerSessionRef.current
    // 容器已经服务于当前会话且在运行：交给下面的「切版本」effect 做增量同步
    if (prevSession === activeId && isBooted()) return
    // 立刻把容器归属占位成当前会话，避免 boot 完成前本 effect 被重复触发又启一遍
    containerSessionRef.current = activeId

    let cancelled = false
    ;(async () => {
      // 切到了不同会话：销毁旧容器 + 清空两处日志面板
      if (isBooted() && prevSession !== activeId) {
        setWCStatus('booting')
        setWCUrl(null)
        await resetContainer()
        clearWcLogs()
      }
      if (cancelled) return

      syncedVersionRef.current = null
      setWCError(null)
      await bootAndRun(currentVersion.files, {
        onStatus: setWCStatus,
        onUrl: setWCUrl,
        onLog: setWCLog,
        onError: setWCError,
      })
      if (cancelled) return
      syncedVersionRef.current = currentVersion.id
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, currentVersion.files])

  // —— 切版本：同会话内文件变更走增量同步（依赖 vite HMR，不重启 dev）——
  useEffect(() => {
    if (!isDevRunning()) return
    // 只同步「当前会话自己的」版本变更；切会话的重挂由上面的 effect 负责，
    // 这里若不挡住，会把新会话的文件 sync 进尚未销毁的旧容器。
    if (containerSessionRef.current !== activeId) return
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
  }, [activeId, currentVersion.id, currentVersion.files, setWCStatus, setWCLog, setWCError])

  // —— 浏览器 console 桥接：iframe → 父页面 ——
  // iframe 里注入的脚本会 postMessage({ type: 'vibuild-console', level, text })，
  // 这里挂全局监听：一边推到控制台面板（给人看），一边攒批回传后端（给 agent 看）。
  useEffect(() => {
    // 把缓冲里的日志一次性发给后端，然后清空
    const flush = () => {
      flushTimerRef.current = null
      const sid = activeIdRef.current
      const batch = pendingLogsRef.current
      if (!sid || batch.length === 0) return
      pendingLogsRef.current = []
      pushLogs(sid, batch)
    }

    const handle = (e: MessageEvent) => {
      const data = e.data
      if (!data || data.type !== 'vibuild-console') return
      // 来源校验：必须来自当前 iframe 的 contentWindow，防止其他 tab 的脏数据
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return
      const level: LogLevel = ['log', 'info', 'warn', 'error'].includes(data.level) ? data.level : 'log'
      const text = String(data.text ?? '')
      pushWcLog({ level, text })

      // 只回传 error / warn：agent 关心的是「报错了没」，普通 log（vite 连接提示等）
      // 是噪声，混进去会把后端那个 50 条上限的缓冲挤爆，真正的报错反而被挤掉。
      if (level === 'error' || level === 'warn') {
        pendingLogsRef.current.push({ level, text, ts: Date.now() })
        // debounce 400ms：同一波报错往往连着来，攒一下合并成一个请求
        if (flushTimerRef.current === null) {
          flushTimerRef.current = setTimeout(flush, 400)
        }
      }
    }

    window.addEventListener('message', handle)
    return () => {
      window.removeEventListener('message', handle)
      // 组件卸载前把没发完的日志补发一次，并清掉定时器
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      flush()
    }
  }, [pushWcLog])

  const showIframe = wcUrl && (wcStatus === 'ready' || wcStatus === 'syncing')
  const isErrored = wcStatus === 'error'

  return (
    <div className={styles.preview}>
      <div className={styles.bgGrid} aria-hidden />
      <div className={styles.bgGlow} aria-hidden />

      <div className={styles.frame}>
        <div className={styles.browser}>

          <div className={styles.viewport}>
            {showIframe && (
              // key 里带上 reloadTick：每次刷新按钮 +1 都会让 React 卸掉重挂，
              // iframe 整个 reset、重新拉一次 wcUrl，比 contentWindow.location.reload()
              // 更稳（后者跨域会报安全错误）。
              <iframe
                key={`${wcUrl}-${reloadTick}`}
                ref={iframeRef}
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
