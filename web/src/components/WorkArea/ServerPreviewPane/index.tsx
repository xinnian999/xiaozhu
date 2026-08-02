import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Braces, LoaderCircle } from 'lucide-react'
import {
  buildServerPreview,
  getGenerationState,
  postBuildResult,
} from '@/lib/api'
import { useSessionStore } from '@/store/session'
import { useUIStore, type PreviewDevice, type ServerPreviewBuild } from '@/store/ui'
import styles from '../PreviewPane/index.module.scss'

const RUNTIME_COLLECT_MS = 1500
// 构建成功后先给 iframe 足够的网络导航时间；load 后再单独等待 bridge ready。
// 两段超时都属于预览基础设施验收，不能伪装成用户代码的运行时错误。
const IFRAME_LOAD_FALLBACK_MS = 30_000
const READY_FALLBACK_MS = 15_000
const IFRAME_READY_RETRY_BASE_MS = 1500
const IFRAME_READY_RETRY_MAX_MS = 10000
const IFRAME_READY_REBUILD_AFTER = 2
const IFRAME_READY_DEV_PAGE_RELOAD_AFTER = 3
const DEV_PAGE_RELOAD_COOLDOWN_MS = 30_000
const MOBILE_CANVAS_WIDTH = 390
const MOBILE_CANVAS_HEIGHT = 844
const buildQueueKey = (sessionId: string, versionId: string) => `${sessionId}\u0000${versionId}`

type PendingCheck = {
  checkId: string
  sessionId: string
  device: PreviewDevice
  runtimeErrors: string[]
  previousDocumentId: string | null
  diagnosticDocumentId: string | null
  documentId: string | null
  done: boolean
}

/** 后端沙箱预览面板。Worker 构建并截图；iframe bridge 只负责交互预览与运行时诊断。 */
export default function ServerPreviewPane() {
  const currentVersion = useSessionStore((s) => s.currentVersion())
  const activeId = useSessionStore((s) => s.activeId)
  const isStreaming = useSessionStore(
    (s) => s.sessions.find((item) => item.id === s.activeId)?.isStreaming ?? false,
  )
  const previewDevice = useUIStore((s) => s.previewDevice)
  const previewStatus = useUIStore((s) => s.previewStatus)
  const previewUrl = useUIStore((s) => s.previewUrl)
  const previewLog = useUIStore((s) => s.previewLog)
  const previewError = useUIStore((s) => s.previewError)
  const reloadTick = useUIStore((s) => s.previewReloadTick)
  const applyRequest = useUIStore((s) => s.previewApplyRequest)
  const navCmd = useUIStore((s) => s.previewNavCmd)
  const setPreviewStatus = useUIStore((s) => s.setPreviewStatus)
  const setPreviewUrl = useUIStore((s) => s.setPreviewUrl)
  const setPreviewLog = useUIStore((s) => s.setPreviewLog)
  const setPreviewError = useUIStore((s) => s.setPreviewError)
  const pushPreviewLog = useUIStore((s) => s.pushPreviewLog)
  const clearPreviewLogs = useUIStore((s) => s.clearPreviewLogs)
  const setPreviewNav = useUIStore((s) => s.setPreviewNav)
  const resetPreviewNav = useUIStore((s) => s.resetPreviewNav)
  const reloadPreview = useUIStore((s) => s.reloadPreview)
  // 分别记录 iframe 的导航完成与 React 首屏 ready；同一加载层据此切换阶段文案。
  const [loadedIframeSrc, setLoadedIframeSrc] = useState<string | null>(null)
  const [readyIframeSrc, setReadyIframeSrc] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const activeEpochRef = useRef(0)
  const handledApplySeqRef = useRef(0)
  const builtVersionRef = useRef<string | null>(null)
  const buildQueueRef = useRef<Promise<void>>(Promise.resolve())
  // key 对应当前会话 epoch。StrictMode 会重放 effect：旧 epoch 的排队任务不能阻止
  // 新 epoch 补发构建，同时旧任务结束时也不能误删新任务的标记。
  const queuedBuildEpochRef = useRef(new Map<string, number>())
  // 页面刷新后的首屏构建先探测后台任务。探测本身也要去重，避免多个 effect 同时查询后
  // 都提交构建，与后台 check_build 争抢单并发 Worker。
  const initialBuildProbeEpochRef = useRef(new Map<string, number>())
  const pendingCheckRef = useRef<PendingCheck | null>(null)
  const collectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const iframeReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const iframeReadyAttemptsRef = useRef(0)
  const iframeRecoveryBuildAttemptedRef = useRef(false)
  // 用文档 ID 隔离 iframe 重载前后的诊断消息，避免旧页面的错误污染新一轮验收。
  const activeDocumentIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (previewDevice !== 'mobile') {
      root.style.removeProperty('--preview-mobile-scale')
      return
    }
    const update = () => {
      const computed = getComputedStyle(root)
      const width =
        root.clientWidth
        - Number.parseFloat(computed.paddingLeft)
        - Number.parseFloat(computed.paddingRight)
      const height =
        root.clientHeight
        - Number.parseFloat(computed.paddingTop)
        - Number.parseFloat(computed.paddingBottom)
      if (width <= 0 || height <= 0) return
      root.style.setProperty(
        '--preview-mobile-scale',
        Math.min(1, width / MOBILE_CANVAS_WIDTH, height / MOBILE_CANVAS_HEIGHT).toFixed(4),
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [previewDevice])

  const clearCheckTimers = useCallback(() => {
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
    collectTimerRef.current = null
    readyFallbackRef.current = null
  }, [])

  const clearIframeReadyTimer = useCallback(() => {
    if (iframeReadyTimerRef.current) clearTimeout(iframeReadyTimerRef.current)
    iframeReadyTimerRef.current = null
  }, [])

  const finishPendingCheck = useCallback((
    terminalError?: string,
    terminalInfrastructure = false,
  ) => {
    const pending = pendingCheckRef.current
    if (!pending || pending.done) return
    pending.done = true
    pendingCheckRef.current = null
    clearCheckTimers()

    const allErrors = [
      ...pending.runtimeErrors,
      ...(terminalError ? [terminalError] : []),
    ]
    // 已收到真实运行时报错时仍按代码问题回报；只有没有代码证据的导航/ready
    // 超时才标记为基础设施异常，避免 Agent 因网络波动反复改写业务代码。
    const infrastructure = (
      terminalInfrastructure
      && pending.runtimeErrors.length === 0
    )
    const result = {
      ok: allErrors.length === 0,
      errors: allErrors.join('\n'),
      runtime: pending.runtimeErrors.length > 0,
      infrastructure,
    }

    // 服务端已经完成真实浏览器截图；前端只补充当前交互 iframe 的运行时诊断。
    void postBuildResult(pending.sessionId, {
      check_id: pending.checkId,
      ...result,
      device: pending.device,
    })
  }, [clearCheckTimers])

  const armPendingCheckTimeout = useCallback((message: string, timeoutMs: number) => {
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
    readyFallbackRef.current = null
    if (!pendingCheckRef.current || pendingCheckRef.current.done) return
    readyFallbackRef.current = setTimeout(() => {
      finishPendingCheck(message, true)
    }, timeoutMs)
  }, [finishPendingCheck])

  const beginRuntimeCollection = useCallback(() => {
    if (!pendingCheckRef.current || pendingCheckRef.current.done) return
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
    readyFallbackRef.current = null
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    collectTimerRef.current = setTimeout(finishPendingCheck, RUNTIME_COLLECT_MS)
  }, [finishPendingCheck])

  const executeBuild = useCallback(async (
    sessionId: string,
    versionId: string,
    files: Record<string, string>,
    checkId: string | null,
    epoch: number,
    serverBuild: ServerPreviewBuild | null,
  ) => {
    if (activeEpochRef.current !== epoch) return
    clearIframeReadyTimer()
    const device = useUIStore.getState().previewDevice
    if (checkId) {
      finishPendingCheck('上一轮预览检查已被新的构建取代', true)
    }
    setPreviewStatus('building')
    setPreviewError(null)
    setPreviewLog(serverBuild ? '正在加载服务端构建结果…' : '正在提交后端沙箱构建…')
    try {
      const result = serverBuild
        ? {
            ok: serverBuild.ok,
            build_id: null,
            preview_url: serverBuild.previewUrl,
            logs: serverBuild.logs,
            errors: serverBuild.errors,
          }
        : await buildServerPreview(sessionId, files, device)
      if (activeEpochRef.current !== epoch) return
      if (result.logs) setPreviewLog(result.logs.split('\n').filter(Boolean).at(-1) ?? '')
      if (!result.ok || !result.preview_url) {
        const message = result.errors || '后端沙箱构建失败'
        setPreviewError(message)
        setPreviewStatus(previewUrl ? 'ready' : 'error')
        pushPreviewLog({ level: 'error', text: message })
        if (checkId && !serverBuild) {
          await postBuildResult(sessionId, {
            check_id: checkId,
            ok: false,
            errors: message,
            runtime: false,
            device,
          })
        }
        return
      }

      builtVersionRef.current = versionId
      if (checkId && !serverBuild) {
        pendingCheckRef.current = {
          checkId,
          sessionId,
          device,
          runtimeErrors: [],
          previousDocumentId: activeDocumentIdRef.current,
          diagnosticDocumentId: null,
          documentId: null,
          done: false,
        }
        armPendingCheckTimeout(
          '预览页面未在 30 秒内完成加载，无法进行运行时验收',
          IFRAME_LOAD_FALLBACK_MS,
        )
      }
      setPreviewUrl(result.preview_url)
      // 相同源码可能返回相同 build_id；仍要重挂 iframe，不能让旧错误文档继续占位。
      reloadPreview()
      setPreviewStatus('ready')
    } catch (error) {
      if (activeEpochRef.current !== epoch) return
      const message = error instanceof Error ? error.message : String(error)
      setPreviewError(message)
      setPreviewStatus(previewUrl ? 'ready' : 'error')
      pushPreviewLog({ level: 'error', text: message })
      if (checkId) {
        await postBuildResult(sessionId, {
          check_id: checkId,
          ok: false,
          errors: message,
          runtime: false,
          infrastructure: true,
          device,
        })
      }
    }
  }, [
    armPendingCheckTimeout,
    clearIframeReadyTimer,
    finishPendingCheck,
    pushPreviewLog,
    setPreviewError,
    setPreviewLog,
    setPreviewStatus,
    setPreviewUrl,
    reloadPreview,
    previewUrl,
  ])

  const enqueueBuild = useCallback((
    sessionId: string,
    versionId: string,
    files: Record<string, string>,
    checkId: string | null,
    serverBuild: ServerPreviewBuild | null = null,
  ) => {
    const epoch = activeEpochRef.current
    const queueKey = buildQueueKey(sessionId, versionId)
    queuedBuildEpochRef.current.set(queueKey, epoch)
    buildQueueRef.current = buildQueueRef.current
      .catch(() => {})
      .then(() => executeBuild(
        sessionId,
        versionId,
        files,
        checkId,
        epoch,
        serverBuild,
      ))
      .finally(() => {
        if (queuedBuildEpochRef.current.get(queueKey) === epoch) {
          queuedBuildEpochRef.current.delete(queueKey)
        }
      })
  }, [executeBuild])

  useEffect(() => {
    activeEpochRef.current += 1
    builtVersionRef.current = null
    if (pendingCheckRef.current) pendingCheckRef.current.done = true
    pendingCheckRef.current = null
    clearCheckTimers()
    clearIframeReadyTimer()
    iframeReadyAttemptsRef.current = 0
    iframeRecoveryBuildAttemptedRef.current = false
    activeDocumentIdRef.current = null
    // 运行时配置异步读取期间，SSE 可能已经送来当前会话的 preview_refresh。
    // 当前请求属于即将挂载的会话时不能当成“旧请求”吞掉；其它会话残留则直接记为已处理。
    handledApplySeqRef.current = (
      applyRequest.sessionId === activeId && applyRequest.checkId
        ? Math.max(0, applyRequest.seq - 1)
        : applyRequest.seq
    )
    setPreviewUrl(null)
    setPreviewError(null)
    setPreviewStatus('idle')
    clearPreviewLogs()
    resetPreviewNav()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (!activeId || Object.keys(currentVersion.files).length === 0) return
    if (
      applyRequest.seq !== handledApplySeqRef.current
      && applyRequest.sessionId === activeId
      && Boolean(applyRequest.checkId)
      && applyRequest.serverBuild !== null
    ) {
      handledApplySeqRef.current = applyRequest.seq
      enqueueBuild(
        activeId,
        currentVersion.id,
        currentVersion.files,
        applyRequest.checkId,
        applyRequest.serverBuild,
      )
      return
    }
    // 生成途中只在 check_build 时揭晓；初始加载、回滚和手动保存则直接构建。
    if (
      !isStreaming
      && builtVersionRef.current !== currentVersion.id
      && (
        queuedBuildEpochRef.current.get(buildQueueKey(activeId, currentVersion.id))
        !== activeEpochRef.current
      )
    ) {
      const sessionId = activeId
      const versionId = currentVersion.id
      const files = currentVersion.files
      const epoch = activeEpochRef.current
      const queueKey = buildQueueKey(sessionId, versionId)
      if (initialBuildProbeEpochRef.current.get(queueKey) === epoch) return
      initialBuildProbeEpochRef.current.set(queueKey, epoch)
      void getGenerationState(sessionId).then((active) => {
        if (initialBuildProbeEpochRef.current.get(queueKey) === epoch) {
          initialBuildProbeEpochRef.current.delete(queueKey)
        }
        if (
          active
          || activeEpochRef.current !== epoch
          || builtVersionRef.current === versionId
          || queuedBuildEpochRef.current.get(queueKey) === epoch
        ) {
          return
        }
        enqueueBuild(sessionId, versionId, files, null)
      })
    }
  }, [
    activeId,
    applyRequest.checkId,
    applyRequest.seq,
    applyRequest.serverBuild,
    applyRequest.sessionId,
    currentVersion.files,
    currentVersion.id,
    enqueueBuild,
    isStreaming,
  ])

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const frame = iframeRef.current
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return
      // 配置独立预览域名时保留生成应用自己的 storage；同源回退模式则使用
      // opaque origin。两种模式都先锁定 iframe 窗口，再校验准确 origin。
      let frameOrigin: string
      try {
        frameOrigin = new URL(frame.src, window.location.href).origin
      } catch {
        return
      }
      if (
        frameOrigin === window.location.origin
          ? event.origin !== 'null'
          : event.origin !== frameOrigin
      ) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data.type !== 'string') return

      const documentId = (
        typeof data.documentId === 'string' && data.documentId.length <= 160
          ? data.documentId
          : ''
      )
      const prepareDiagnostics = (pending: PendingCheck) => {
        if (
          !documentId
          || documentId === pending.previousDocumentId
          || (pending.documentId !== null && pending.documentId !== documentId)
        ) {
          return false
        }
        if (pending.diagnosticDocumentId !== documentId) {
          pending.diagnosticDocumentId = documentId
          pending.runtimeErrors = []
        }
        return true
      }

      if (data.type === 'xiaozhu-server-runtime-error') {
        const message = typeof data.message === 'string' ? data.message.slice(0, 4000) : ''
        const pending = pendingCheckRef.current
        if (
          message
          && pending
          && !pending.done
          && prepareDiagnostics(pending)
          && pending.runtimeErrors.length < 8
          && !pending.runtimeErrors.includes(message)
        ) {
          pending.runtimeErrors.push(message)
          pushPreviewLog({ level: 'error', text: message })
        }
      } else if (data.type === 'xiaozhu-server-ready') {
        const width = Number(data.width)
        const height = Number(data.height)
        if (
          !documentId
          || !Number.isFinite(width)
          || width < 1
          || width > 20000
          || !Number.isFinite(height)
          || height < 1
          || height > 20000
        ) {
          return
        }
        clearIframeReadyTimer()
        iframeReadyAttemptsRef.current = 0
        iframeRecoveryBuildAttemptedRef.current = false
        const currentFrameSrc = iframeRef.current?.src ?? null
        setLoadedIframeSrc(currentFrameSrc)
        setReadyIframeSrc(currentFrameSrc)
        if (['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) {
          sessionStorage.removeItem(`xiaozhu:preview-recovery:${activeId ?? ''}`)
          const recoveryUrl = new URL(window.location.href)
          if (recoveryUrl.searchParams.has('__xiaozhu_preview_recovery')) {
            recoveryUrl.searchParams.delete('__xiaozhu_preview_recovery')
            window.history.replaceState(
              window.history.state,
              '',
              `${recoveryUrl.pathname}${recoveryUrl.search}${recoveryUrl.hash}`,
            )
          }
        }
        const pending = pendingCheckRef.current
        if (pending && !pending.done && documentId === pending.previousDocumentId) return
        activeDocumentIdRef.current = documentId
        if (!pending || pending.done) return
        if (pending.diagnosticDocumentId !== documentId) {
          pending.diagnosticDocumentId = documentId
          pending.runtimeErrors = []
        }
        pending.documentId = documentId
        beginRuntimeCollection()
      } else if (data.type === 'xiaozhu-server-navigation') {
        const path = typeof data.path === 'string' ? data.path.slice(0, 1000) : '/'
        setPreviewNav({ path, canBack: false, canForward: false })
      }
    }
    window.addEventListener('message', handle)
    return () => window.removeEventListener('message', handle)
  }, [activeId, beginRuntimeCollection, clearIframeReadyTimer, pushPreviewLog, setPreviewNav])

  const requestIframeReady = useCallback(() => {
    const iframe = iframeRef.current
    const win = iframe?.contentWindow
    if (!iframe || !win) return
    try {
      const frameOrigin = new URL(iframe.src, window.location.href).origin
      // 同源回退实际是 opaque origin，只能用 *；独立预览域则精确限制目标 Origin。
      win.postMessage(
        { type: 'xiaozhu-ready-request' },
        frameOrigin === window.location.origin ? '*' : frameOrigin,
      )
    } catch {
      // 无效 URL 会由既有 ready 超时路径给出明确错误。
    }
  }, [])

  const armIframeReadyRecovery = useCallback(() => {
    clearIframeReadyTimer()
    const epoch = activeEpochRef.current
    const delay = Math.min(
      IFRAME_READY_RETRY_MAX_MS,
      IFRAME_READY_RETRY_BASE_MS * (2 ** Math.min(iframeReadyAttemptsRef.current, 3)),
    )
    iframeReadyTimerRef.current = setTimeout(() => {
      iframeReadyTimerRef.current = null
      if (
        activeEpochRef.current !== epoch
        || !previewUrl
        || !activeId
        || Object.keys(currentVersion.files).length === 0
      ) {
        return
      }

      iframeReadyAttemptsRef.current += 1
      if (
        iframeReadyAttemptsRef.current >= IFRAME_READY_DEV_PAGE_RELOAD_AFTER
        && ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
      ) {
        // Chrome 在 dev 服务整体重启后可能把 preview.localhost 的连接拒绝记在当前
        // 顶层浏览上下文中：iframe 换 key、换 capability、加 cache-bust 均仍返回
        // 错误页，只有一次顶层冷导航能清掉。仅 loopback 启用，并用 sessionStorage
        // 限流，避免服务持续离线时形成刷新循环。
        const recoveryKey = `xiaozhu:preview-recovery:${activeId}`
        const previousReloadAt = Number(sessionStorage.getItem(recoveryKey) || '0')
        const now = Date.now()
        if (now - previousReloadAt >= DEV_PAGE_RELOAD_COOLDOWN_MS) {
          // dev 整组服务尚未恢复时绝不能刷新顶层页面，否则它会变成 Chrome 自带的
          // ERR_CONNECTION_REFUSED，应用代码随之消失，再也没有机会自动重试。
          void fetch('/api/setup-status', {
            cache: 'no-store',
            credentials: 'same-origin',
          }).then((response) => {
            if (!response.ok) throw new Error(`dev API ${response.status}`)
            sessionStorage.setItem(recoveryKey, String(Date.now()))
            // 普通 reload 会复用 Chrome 已污染的子 frame browsing context；改成不同
            // 顶层 URL 的 replace 导航，等 ready 后再无刷新地清掉内部参数。
            const recoveryUrl = new URL(window.location.href)
            recoveryUrl.searchParams.set('__xiaozhu_preview_recovery', String(Date.now()))
            window.location.replace(recoveryUrl.toString())
          }).catch(() => {
            // 主站仍离线：只刷新 iframe，并由下一次 onLoad 继续指数退避。
            reloadPreview()
          })
          return
        }
      }
      if (
        iframeReadyAttemptsRef.current >= IFRAME_READY_REBUILD_AFTER
        && !iframeRecoveryBuildAttemptedRef.current
      ) {
        // capability 过期、产物被清理或 Worker bridge 升级时，仅重挂旧 URL 不够；
        // 每次失败周期最多主动重建一次，避免服务长期离线时形成构建风暴。
        iframeRecoveryBuildAttemptedRef.current = true
        enqueueBuild(activeId, currentVersion.id, currentVersion.files, null)
        return
      }

      // CSP 拒绝页、ERR_CONNECTION_REFUSED 等浏览器错误文档不会响应 postMessage。
      // React key 重挂才能发起一次真正的新导航；指数退避后会持续等待 dev 服务恢复。
      reloadPreview()
    }, delay)
  }, [
    activeId,
    clearIframeReadyTimer,
    currentVersion.files,
    currentVersion.id,
    enqueueBuild,
    previewUrl,
    reloadPreview,
  ])

  const handleIframeLoad = useCallback(() => {
    // load 只表示文档完成导航；加载层继续显示，直到 bridge 确认 React 首屏已绘制。
    setLoadedIframeSrc(iframeRef.current?.src ?? null)
    setReadyIframeSrc(null)
    armPendingCheckTimeout(
      '预览页面已加载，但未在 15 秒内发送就绪信号，无法进行运行时验收',
      READY_FALLBACK_MS,
    )
    requestIframeReady()
    armIframeReadyRecovery()
  }, [armIframeReadyRecovery, armPendingCheckTimeout, requestIframeReady])

  useEffect(() => {
    if (!navCmd.seq) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'xiaozhu-nav-cmd', action: navCmd.action },
      '*',
    )
  }, [navCmd.action, navCmd.seq])

  useEffect(() => () => {
    activeEpochRef.current += 1
    if (pendingCheckRef.current) pendingCheckRef.current.done = true
    pendingCheckRef.current = null
    clearCheckTimers()
    clearIframeReadyTimer()
    activeDocumentIdRef.current = null
  }, [clearCheckTimers, clearIframeReadyTimer])

  // Chrome 会按 URL 缓存 iframe 的 ERR_CONNECTION_REFUSED/CSP 错误文档；只改 React key
  // 仍可能继续显示旧错误页。每次重挂都附带新的无语义查询参数，强制一次真实网络导航。
  const iframeSrc = previewUrl
    ? (() => {
        const url = new URL(previewUrl, window.location.origin)
        url.searchParams.set('__xiaozhu_reload', String(reloadTick))
        return url.toString()
      })()
    : null
  const hasIframe = Boolean(iframeSrc)
  const previewHasIsolatedOrigin = Boolean(
    iframeSrc
    && new URL(iframeSrc).origin !== window.location.origin,
  )
  const isIframeLoaded = Boolean(iframeSrc && loadedIframeSrc === iframeSrc)
  const isIframeReady = Boolean(iframeSrc && readyIframeSrc === iframeSrc)
  const isPreviewReady = previewStatus === 'ready' && isIframeReady
  const isPreviewError = previewStatus === 'error'
  // 首次生成尚未进入 check_build 时，右侧只是等待模型写完代码，不是 iframe 在加载。
  // 此阶段使用静态说明，避免持续旋转的 loading 让用户误以为预览服务卡住。
  const isWaitingForFirstBuild = previewStatus === 'idle' && !hasIframe
  const loadingLabel = previewStatus === 'building'
    ? '正在构建预览…'
    : !hasIframe
        ? '正在准备预览…'
        : !isIframeLoaded
            ? '正在加载页面…'
            : '正在渲染界面…'
  // 重建期间保留已完成的旧页面作为上下文；新 URL 开始导航后再用不透明层遮住空白。
  const loadingOverReadyPreview = previewStatus === 'building' && isIframeReady
  useEffect(() => {
    if (!hasIframe) return
    // 开发热更新可能保留旧 iframe，不再触发 load；主动握手可避免加载层滞留。
    requestIframeReady()
  }, [hasIframe, iframeSrc, requestIframeReady])
  return (
    <div
      ref={rootRef}
      className={`${styles.preview} ${previewDevice === 'mobile' ? styles.mobileCanvas : ''}`}
      data-preview-device={previewDevice}
    >
      <div className={styles.bgGrid} aria-hidden />
      <div className={styles.bgGlow} aria-hidden />
      <div className={styles.frame}>
        <div className={styles.browser}>
          <div className={styles.viewport} aria-busy={!isPreviewReady && !isPreviewError}>
            {hasIframe && (
              <iframe
                key={iframeSrc}
                ref={iframeRef}
                src={iframeSrc!}
                className={styles.iframe}
                title="界面预览"
                onLoad={handleIframeLoad}
                sandbox={[
                  'allow-scripts',
                  'allow-forms',
                  'allow-modals',
                  ...(previewHasIsolatedOrigin ? ['allow-same-origin'] : []),
                ].join(' ')}
                referrerPolicy="no-referrer"
              />
            )}
            <div
              className={[
                styles.previewState,
                isPreviewReady ? styles.previewStateHidden : '',
                loadingOverReadyPreview ? styles.previewStateOverContent : '',
                isPreviewError ? styles.previewStateError : '',
              ].filter(Boolean).join(' ')}
              role={isPreviewError ? 'alert' : 'status'}
              aria-live="polite"
              aria-hidden={isPreviewReady}
            >
              {isPreviewError ? (
                <div className={styles.stateError}>
                  <AlertTriangle size={20} />
                  <h3>界面生成失败</h3>
                  <p>{previewError ?? '未知错误'}</p>
                  <p className={styles.errorHint}>检查 Worker 状态、密钥和预览域名配置。</p>
                </div>
              ) : (
                <div className={styles.stateContent}>
                  {isWaitingForFirstBuild ? (
                    <>
                      <Braces
                        className={styles.waitingIcon}
                        size={32}
                        strokeWidth={1.7}
                        aria-hidden
                      />
                      <p className={styles.stateLabel}>代码生成中</p>
                      <p className={styles.stateHint}>完成后会自动展示可交互预览</p>
                    </>
                  ) : (
                    <>
                      <LoaderCircle
                        className={styles.loaderIcon}
                        size={34}
                        strokeWidth={1.8}
                        aria-hidden
                      />
                      <p className={styles.stateLabel}>{loadingLabel}</p>
                    </>
                  )}
                  {previewStatus === 'building' && previewLog && (
                    <pre className={styles.stateDetail}>{previewLog}</pre>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
