import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { buildServerPreview, postBuildResult } from '@/lib/api'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import styles from '../PreviewPane/index.module.scss'

const RUNTIME_COLLECT_MS = 1500
const READY_FALLBACK_MS = 8000
const MOBILE_CANVAS_WIDTH = 390
const MOBILE_CANVAS_HEIGHT = 844

type PendingCheck = {
  checkId: string
  sessionId: string
  runtimeErrors: string[]
  done: boolean
}

/** 后端沙箱预览面板。构建由独立 Worker 完成，iframe 只负责展示产物与回传运行时错误。 */
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

  const rootRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const activeEpochRef = useRef(0)
  const handledApplySeqRef = useRef(0)
  const builtVersionRef = useRef<string | null>(null)
  const buildQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingCheckRef = useRef<PendingCheck | null>(null)
  const collectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const finishPendingCheck = useCallback(() => {
    const pending = pendingCheckRef.current
    if (!pending || pending.done) return
    pending.done = true
    pendingCheckRef.current = null
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
    collectTimerRef.current = null
    readyFallbackRef.current = null
    const errors = pending.runtimeErrors.join('\n')
    void postBuildResult(pending.sessionId, {
      check_id: pending.checkId,
      ok: !errors,
      errors,
      runtime: Boolean(errors),
      visual: false,
      device: useUIStore.getState().previewDevice,
    })
  }, [])

  const beginRuntimeCollection = useCallback(() => {
    if (!pendingCheckRef.current || pendingCheckRef.current.done) return
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    collectTimerRef.current = setTimeout(finishPendingCheck, RUNTIME_COLLECT_MS)
  }, [finishPendingCheck])

  const executeBuild = useCallback(async (
    sessionId: string,
    versionId: string,
    files: Record<string, string>,
    checkId: string | null,
    epoch: number,
  ) => {
    setPreviewStatus('building')
    setPreviewError(null)
    setPreviewLog('正在提交后端沙箱构建…')
    try {
      const result = await buildServerPreview(
        sessionId,
        files,
        useUIStore.getState().previewDevice,
      )
      if (activeEpochRef.current !== epoch) return
      if (result.logs) setPreviewLog(result.logs.split('\n').filter(Boolean).at(-1) ?? '')
      if (!result.ok || !result.preview_url) {
        const message = result.errors || '后端沙箱构建失败'
        setPreviewError(message)
        setPreviewStatus(previewUrl ? 'ready' : 'error')
        pushPreviewLog({ level: 'error', text: message })
        if (checkId) {
          await postBuildResult(sessionId, {
            check_id: checkId,
            ok: false,
            errors: message,
            runtime: false,
            visual: false,
            device: useUIStore.getState().previewDevice,
          })
        }
        return
      }

      builtVersionRef.current = versionId
      if (checkId) {
        pendingCheckRef.current = {
          checkId,
          sessionId,
          runtimeErrors: [],
          done: false,
        }
        readyFallbackRef.current = setTimeout(finishPendingCheck, READY_FALLBACK_MS)
      }
      setPreviewUrl(result.preview_url)
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
          visual: false,
          device: useUIStore.getState().previewDevice,
        })
      }
    }
  }, [
    finishPendingCheck,
    pushPreviewLog,
    setPreviewError,
    setPreviewLog,
    setPreviewStatus,
    setPreviewUrl,
    previewUrl,
  ])

  const enqueueBuild = useCallback((
    sessionId: string,
    versionId: string,
    files: Record<string, string>,
    checkId: string | null,
  ) => {
    const epoch = activeEpochRef.current
    buildQueueRef.current = buildQueueRef.current
      .catch(() => {})
      .then(() => executeBuild(sessionId, versionId, files, checkId, epoch))
  }, [executeBuild])

  useEffect(() => {
    activeEpochRef.current += 1
    builtVersionRef.current = null
    pendingCheckRef.current = null
    // 运行时配置异步读取期间，SSE 可能已经送来当前会话的 preview_refresh。
    // 当前请求属于即将挂载的会话时不能当成“旧请求”吞掉；其它会话残留则直接记为已处理。
    handledApplySeqRef.current = (
      applyRequest.sessionId === activeId && applyRequest.checkId
        ? Math.max(0, applyRequest.seq - 1)
        : applyRequest.seq
    )
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
    setPreviewUrl(null)
    setPreviewError(null)
    setPreviewStatus('idle')
    clearPreviewLogs()
    resetPreviewNav()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  useEffect(() => {
    if (!activeId || Object.keys(currentVersion.files).length === 0) return
    const isReveal = (
      applyRequest.seq !== handledApplySeqRef.current
      && applyRequest.sessionId === activeId
      && Boolean(applyRequest.checkId)
    )
    if (isReveal) {
      handledApplySeqRef.current = applyRequest.seq
      enqueueBuild(activeId, currentVersion.id, currentVersion.files, applyRequest.checkId)
      return
    }
    // 生成途中只在 check_build 时揭晓；初始加载、回滚和手动保存则直接构建。
    if (!isStreaming && builtVersionRef.current !== currentVersion.id) {
      enqueueBuild(activeId, currentVersion.id, currentVersion.files, null)
    }
  }, [
    activeId,
    applyRequest.checkId,
    applyRequest.seq,
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
      try {
        if (event.origin !== new URL(frame.src).origin) return
      } catch {
        return
      }
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data.type !== 'string') return
      if (data.type === 'xiaozhu-server-runtime-error') {
        const message = typeof data.message === 'string' ? data.message.slice(0, 4000) : ''
        if (message && pendingCheckRef.current && !pendingCheckRef.current.done) {
          pendingCheckRef.current.runtimeErrors.push(message)
          pushPreviewLog({ level: 'error', text: message })
        }
      } else if (data.type === 'xiaozhu-server-ready') {
        beginRuntimeCollection()
      } else if (data.type === 'xiaozhu-server-navigation') {
        const path = typeof data.path === 'string' ? data.path.slice(0, 1000) : '/'
        setPreviewNav({ path, canBack: false, canForward: false })
      }
    }
    window.addEventListener('message', handle)
    return () => window.removeEventListener('message', handle)
  }, [beginRuntimeCollection, pushPreviewLog, setPreviewNav])

  useEffect(() => {
    if (!navCmd.seq) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'xiaozhu-nav-cmd', action: navCmd.action },
      '*',
    )
  }, [navCmd.action, navCmd.seq])

  useEffect(() => () => {
    activeEpochRef.current += 1
    if (collectTimerRef.current) clearTimeout(collectTimerRef.current)
    if (readyFallbackRef.current) clearTimeout(readyFallbackRef.current)
  }, [])

  const showIframe = previewStatus === 'ready' && Boolean(previewUrl)
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
          <div className={styles.viewport}>
            {showIframe && (
              <iframe
                key={`${previewUrl}-${reloadTick}`}
                ref={iframeRef}
                src={previewUrl!}
                className={styles.iframe}
                title="后端沙箱预览"
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              />
            )}
            {!showIframe && (
              <div className={styles.overlay}>
                {previewStatus === 'error' ? (
                  <div className={styles.errBlock}>
                    <AlertTriangle size={20} />
                    <h3>后端沙箱启动失败</h3>
                    <p>{previewError ?? '未知错误'}</p>
                    <p className={styles.errHint}>检查 Worker 状态、密钥和预览域名配置。</p>
                  </div>
                ) : (
                  <div className={styles.booting}>
                    <div className={styles.pctNumber}>…</div>
                    <p className={styles.statusLabel}>
                      {previewStatus === 'building' ? '正在后端隔离环境中构建…' : '正在准备后端沙箱…'}
                    </p>
                    {previewLog && <pre className={styles.bootLog}>{previewLog}</pre>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
