import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
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
  // 当前会话是否在流式生成中 —— 生成途中不自动同步预览（等 AI 主动 update_preview）
  const isStreaming = useSessionStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.isStreaming ?? false,
  )

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
  // 应用计数器：变化即把当前暂存文件增量同步进预览（AI 调 update_preview 时自增）
  const applyTick = useUIStore((s) => s.previewApplyTick)

  // 标记上次同步的版本号，避免同 version 反复 sync
  const syncedVersionRef = useRef<string | null>(null)
  // 标记上次「应用」用到的 applyTick —— 区分「是新的 update_preview 请求」还是
  // 「流式途中 version 变了但还没到揭晓时机」
  const appliedTickRef = useRef(0)
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

  // —— 把文件变更增量同步进运行中的预览（依赖 vite HMR，不重启 dev）——
  // 触发来源有两类：
  //   1. 流式生成途中：AI 调 update_preview → applyTick 自增 → 揭晓一次完整改动；
  //      本轮结束（isStreaming 翻 false 让本 effect 重跑）→ 兜底同步最终态。
  //   2. 非流式：回滚版本等场景，version 一变就直接同步。
  // 流式途中每个 file_write 都会 bump version，但我们故意不跟着同步 ——
  // 否则又会把「组件写好、样式没跟上」的半成品闪给用户（这正是本次改造要解决的）。
  useEffect(() => {
    if (!isDevRunning()) return
    // 只同步「当前会话自己的」版本变更；切会话的重挂由上面的 effect 负责，
    // 这里若不挡住，会把新会话的文件 sync 进尚未销毁的旧容器。
    if (containerSessionRef.current !== activeId) return
    if (syncedVersionRef.current === currentVersion.id) return
    // 流式途中、且不是「新的 update_preview 请求」→ 暂不同步，保持上一个稳定态
    if (isStreaming && applyTick === appliedTickRef.current) return
    appliedTickRef.current = applyTick

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
  }, [activeId, currentVersion.id, currentVersion.files, applyTick, isStreaming, setWCStatus, setWCLog, setWCError])

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

  // ready 时延迟 900ms 再显示 iframe，让进度条动画有时间跑到 100%
  // syncing 是增量文件同步，iframe 保持可见，交给 vite HMR 处理，不触发 overlay
  const [iframeVisible, setIframeVisible] = useState(false)
  useEffect(() => {
    if (wcStatus === 'ready' && wcUrl) {
      const t = setTimeout(() => setIframeVisible(true), 900)
      return () => clearTimeout(t)
    } else if (wcStatus !== 'syncing') {
      setIframeVisible(false)
    }
  }, [wcStatus, wcUrl])

  const showIframe = iframeVisible && wcUrl && (wcStatus === 'ready' || wcStatus === 'syncing')
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
// boot/install/start 进行时的 overlay
// ============================================

// 每个阶段对应的目标进度百分比
const STATUS_PROGRESS: Record<string, number> = {
  booting:    8,
  mounting:   25,
  installing: 65,
  starting:   88,
  ready:      100,
}

// 每个阶段展示给用户的描述文案
const STATUS_LABEL: Record<string, string> = {
  booting:    '正在启动运行环境…',
  mounting:   '正在写入项目文件…',
  installing: '正在准备依赖包…',
  starting:   '正在启动开发服务…',
  ready:      '即将完成…',
}

function BootingBlock({ status, log }: { status: WCStatus; log: string }) {
  const target = STATUS_PROGRESS[status] ?? 0
  const label = STATUS_LABEL[status] ?? '正在加载…'

  // 动画当前显示值，用 ref 驱动 raf 避免闭包过期
  const [display, setDisplay] = useState(0)
  const displayRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)

    // 每个阶段有两段速度：
    //   sprint：快速冲向目标值（0.8s 内追上）
    //   drift ：到达目标后每秒缓慢 +1，让数字保持"活着"的感觉，最多漂移到 target+8
    const SPRINT_DURATION = 800  // ms
    const start = displayRef.current
    const startTime = performance.now()

    const tick = (now: number) => {
      const elapsed = now - startTime

      let next: number
      if (elapsed < SPRINT_DURATION) {
        // easeOutCubic sprint
        const t = elapsed / SPRINT_DURATION
        const ease = 1 - Math.pow(1 - t, 3)
        next = start + (target - start) * ease
        // 浮点误差可能让最后一帧停在 99.xx，sprint 结束时直接 snap 到 target
        if (elapsed >= SPRINT_DURATION - 16) next = target
      } else {
        // drift：每秒 +0.6，缓慢爬行；target=100 时不 drift，保持 100
        const driftCap = target >= 100 ? 100 : Math.min(target + 8, 99)
        const driftSec = (elapsed - SPRINT_DURATION) / 1000
        next = Math.min(target + driftSec * 0.6, driftCap)
      }

      const floored = Math.floor(next)
      if (floored !== Math.floor(displayRef.current)) {
        displayRef.current = next
        setDisplay(floored)
      } else {
        displayRef.current = next
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [target])

  return (
    <div className={styles.booting}>
      <div className={styles.pctNumber}>{display}<span>%</span></div>
      <div className={styles.progressTrack}>
        <div className={styles.progressBar} style={{ width: `${display}%` }} />
      </div>
      <p className={styles.statusLabel}>{label}</p>
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
