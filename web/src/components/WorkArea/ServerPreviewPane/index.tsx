import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { buildServerPreview, postBuildResult, uploadPreviewScreenshot } from '@/lib/api'
import { useSessionStore } from '@/store/session'
import { useUIStore, type PreviewDevice } from '@/store/ui'
import styles from '../PreviewPane/index.module.scss'

const RUNTIME_COLLECT_MS = 1500
const READY_FALLBACK_MS = 8000
const CAPTURE_TIMEOUT_MS = 10000
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_SCREENSHOT_SIDE = 1280
const SCREENSHOT_MIMES = new Set(['image/webp', 'image/png', 'image/jpeg'])
const MOBILE_CANVAS_WIDTH = 390
const MOBILE_CANVAS_HEIGHT = 844
const buildQueueKey = (sessionId: string, versionId: string) => `${sessionId}\u0000${versionId}`

type PendingCheck = {
  checkId: string
  sessionId: string
  device: PreviewDevice
  runtimeErrors: string[]
  layoutIssues: string[]
  previousDocumentId: string | null
  diagnosticDocumentId: string | null
  documentId: string | null
  done: boolean
}

type CaptureDocument = {
  id: string
  width: number
  height: number
}

type CapturedScreenshot = {
  blob: Blob
  width: number
  height: number
  path: string
  mime: string
  device: PreviewDevice
}

type PendingCapture = {
  documentId: string
  device: PreviewDevice
  resolve: (screenshot: CapturedScreenshot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 后端沙箱预览面板。Worker 构建；可信 iframe bridge 回传运行时、布局与受限截图。 */
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
  const queuedBuildCountRef = useRef(new Map<string, number>())
  const pendingCheckRef = useRef<PendingCheck | null>(null)
  const collectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readyFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingCaptureRef = useRef(new Map<string, PendingCapture>())
  const captureDocumentRef = useRef<CaptureDocument | null>(null)
  const lastCaptureViewportRef = useRef<{ width: number; height: number } | null>(null)

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

  const cancelPendingCaptures = useCallback((reason: string) => {
    for (const pending of pendingCaptureRef.current.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    pendingCaptureRef.current.clear()
  }, [])

  /** 预览可能因为代码 tab 或移动端聊天视图而隐藏；截图时短暂移到屏幕外布局。 */
  const prepareCaptureLayout = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe || (iframe.clientWidth > 1 && iframe.clientHeight > 1)) return () => {}

    const saved = new Map<HTMLElement, string>()
    const remember = (element: HTMLElement | null) => {
      if (element && !saved.has(element)) saved.set(element, element.style.cssText)
    }
    const previewRoot = iframe.closest(`.${styles.preview}`) as HTMLElement | null
    const pane = previewRoot?.parentElement ?? null
    const work = pane?.closest('section') as HTMLElement | null
    const previousViewport = lastCaptureViewportRef.current
    const targetWidth = Math.max(
      320,
      previousViewport?.width || work?.clientWidth || window.innerWidth,
    )
    const targetHeight = Math.max(
      480,
      previousViewport?.height || work?.clientHeight || window.innerHeight,
    )

    if (work && getComputedStyle(work).display === 'none') {
      remember(work)
      work.style.setProperty('display', 'flex', 'important')
      work.style.setProperty('position', 'fixed', 'important')
      work.style.setProperty('left', '-200vw', 'important')
      work.style.setProperty('top', '0', 'important')
      work.style.setProperty('width', `${targetWidth}px`, 'important')
      work.style.setProperty('height', `${targetHeight}px`, 'important')
      work.style.setProperty('pointer-events', 'none', 'important')
    }
    if (pane && getComputedStyle(pane).display === 'none') {
      remember(pane)
      pane.style.setProperty('display', 'block', 'important')
      pane.style.setProperty('position', 'fixed', 'important')
      pane.style.setProperty('left', '-200vw', 'important')
      pane.style.setProperty('top', '0', 'important')
      pane.style.setProperty('width', `${targetWidth}px`, 'important')
      pane.style.setProperty('height', `${targetHeight}px`, 'important')
      pane.style.setProperty('pointer-events', 'none', 'important')
    }

    return () => {
      for (const [element, cssText] of saved) element.style.cssText = cssText
    }
  }, [])

  const captureIframeScreenshot = useCallback(async (
    expectedDocumentId: string,
    device: PreviewDevice,
  ): Promise<CapturedScreenshot> => {
    const iframe = iframeRef.current
    const win = iframe?.contentWindow
    if (!iframe || !win) throw new Error('预览 iframe 尚未就绪')
    if (captureDocumentRef.current?.id !== expectedDocumentId) {
      throw new Error('预览文档已经变化，取消过期截图')
    }

    const restoreLayout = prepareCaptureLayout()
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (
        iframeRef.current !== iframe
        || iframe.clientWidth <= 1
        || iframe.clientHeight <= 1
      ) {
        throw new Error('预览面板当前没有可截图尺寸')
      }
      if (captureDocumentRef.current?.id !== expectedDocumentId) {
        throw new Error('预览文档尚未稳定')
      }
      lastCaptureViewportRef.current = {
        width: iframe.clientWidth,
        height: iframe.clientHeight,
      }

      const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      let targetOrigin: string
      try {
        const frameOrigin = new URL(iframe.src, window.location.href).origin
        // 同源回退 iframe 没有 allow-same-origin，实际是 opaque origin，只能以 * 投递。
        targetOrigin = frameOrigin === window.location.origin ? '*' : frameOrigin
      } catch {
        throw new Error('预览地址无效')
      }

      return await new Promise<CapturedScreenshot>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCaptureRef.current.delete(requestId)
          reject(new Error('预览截图超时'))
        }, CAPTURE_TIMEOUT_MS)
        pendingCaptureRef.current.set(requestId, {
          documentId: expectedDocumentId,
          device,
          resolve,
          reject,
          timer,
        })
        try {
          win.postMessage({
            type: 'xiaozhu-capture-request',
            id: requestId,
            documentId: expectedDocumentId,
            background: getComputedStyle(iframe).backgroundColor || '#ffffff',
          }, targetOrigin)
        } catch (error) {
          clearTimeout(timer)
          pendingCaptureRef.current.delete(requestId)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    } finally {
      restoreLayout()
    }
  }, [prepareCaptureLayout])

  const finishPendingCheck = useCallback((terminalError?: string) => {
    const pending = pendingCheckRef.current
    if (!pending || pending.done) return
    pending.done = true
    pendingCheckRef.current = null
    clearCheckTimers()

    const allErrors = [
      ...pending.runtimeErrors,
      ...pending.layoutIssues,
      ...(terminalError ? [terminalError] : []),
    ]
    const result = {
      ok: allErrors.length === 0,
      errors: allErrors.join('\n'),
      runtime: pending.runtimeErrors.length > 0,
      visual: pending.layoutIssues.length > 0,
    }

    void (async () => {
      let screenshotId: string | undefined
      if (!terminalError && pending.documentId) {
        try {
          const captured = await captureIframeScreenshot(pending.documentId, pending.device)
          useSessionStore.getState().setToolScreenshot(
            pending.checkId,
            {
              id: `local-${pending.checkId}`,
              url: URL.createObjectURL(captured.blob),
              width: captured.width,
              height: captured.height,
              path: captured.path,
              mime: captured.mime,
              device: captured.device,
              local: true,
            },
            pending.sessionId,
          )
          const uploaded = await uploadPreviewScreenshot(
            pending.sessionId,
            pending.checkId,
            captured.blob,
            {
              width: captured.width,
              height: captured.height,
              path: captured.path,
              device: captured.device,
            },
          )
          if (uploaded) {
            useSessionStore.getState().setToolScreenshot(
              pending.checkId,
              uploaded,
              pending.sessionId,
            )
          }
          screenshotId = uploaded?.id
        } catch (error) {
          console.warn('预览截图失败', error)
        }
      }

      await postBuildResult(pending.sessionId, {
        check_id: pending.checkId,
        ...result,
        device: pending.device,
        ...(screenshotId ? { screenshot_id: screenshotId } : {}),
      })
    })()
  }, [captureIframeScreenshot, clearCheckTimers])

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
  ) => {
    if (activeEpochRef.current !== epoch) return
    const device = useUIStore.getState().previewDevice
    if (checkId) {
      cancelPendingCaptures('预览检查已被新的构建取代')
      finishPendingCheck('上一轮预览检查已被新的构建取代')
    }
    setPreviewStatus('building')
    setPreviewError(null)
    setPreviewLog('正在提交后端沙箱构建…')
    try {
      const result = await buildServerPreview(sessionId, files, device)
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
            device,
          })
        }
        return
      }

      builtVersionRef.current = versionId
      if (checkId) {
        pendingCheckRef.current = {
          checkId,
          sessionId,
          device,
          runtimeErrors: [],
          layoutIssues: [],
          previousDocumentId: captureDocumentRef.current?.id ?? null,
          diagnosticDocumentId: null,
          documentId: null,
          done: false,
        }
        readyFallbackRef.current = setTimeout(() => {
          finishPendingCheck('预览未在 8 秒内发送就绪信号，无法完成运行时验收')
        }, READY_FALLBACK_MS)
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
          device,
        })
      }
    }
  }, [
    cancelPendingCaptures,
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
    const queueKey = buildQueueKey(sessionId, versionId)
    const queuedCount = queuedBuildCountRef.current.get(queueKey) ?? 0
    queuedBuildCountRef.current.set(queueKey, queuedCount + 1)
    buildQueueRef.current = buildQueueRef.current
      .catch(() => {})
      .then(() => executeBuild(sessionId, versionId, files, checkId, epoch))
      .finally(() => {
        const remaining = (queuedBuildCountRef.current.get(queueKey) ?? 1) - 1
        if (remaining > 0) queuedBuildCountRef.current.set(queueKey, remaining)
        else queuedBuildCountRef.current.delete(queueKey)
      })
  }, [executeBuild])

  useEffect(() => {
    activeEpochRef.current += 1
    builtVersionRef.current = null
    if (pendingCheckRef.current) pendingCheckRef.current.done = true
    pendingCheckRef.current = null
    clearCheckTimers()
    cancelPendingCaptures('预览会话已切换')
    captureDocumentRef.current = null
    lastCaptureViewportRef.current = null
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
    ) {
      handledApplySeqRef.current = applyRequest.seq
      enqueueBuild(activeId, currentVersion.id, currentVersion.files, applyRequest.checkId)
      return
    }
    // 生成途中只在 check_build 时揭晓；初始加载、回滚和手动保存则直接构建。
    if (
      !isStreaming
      && builtVersionRef.current !== currentVersion.id
      && !queuedBuildCountRef.current.has(buildQueueKey(activeId, currentVersion.id))
    ) {
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

      if (data.type === 'xiaozhu-capture-result') {
        const requestId = typeof data.id === 'string' ? data.id : ''
        const pending = pendingCaptureRef.current.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingCaptureRef.current.delete(requestId)
        if (
          data.documentId === pending.documentId
          && captureDocumentRef.current?.id === pending.documentId
          && data.ok === true
          && data.bytes instanceof ArrayBuffer
          && data.bytes.byteLength > 0
          && data.bytes.byteLength <= MAX_SCREENSHOT_BYTES
          && typeof data.mime === 'string'
          && SCREENSHOT_MIMES.has(data.mime)
          && typeof data.width === 'number'
          && Number.isInteger(data.width)
          && data.width > 0
          && data.width <= MAX_SCREENSHOT_SIDE
          && typeof data.height === 'number'
          && Number.isInteger(data.height)
          && data.height > 0
          && data.height <= MAX_SCREENSHOT_SIDE
        ) {
          pending.resolve({
            blob: new Blob([data.bytes], { type: data.mime }),
            width: data.width,
            height: data.height,
            path: typeof data.path === 'string' ? data.path.slice(0, 2048) : '/',
            mime: data.mime,
            device: pending.device,
          })
        } else {
          pending.reject(new Error(
            typeof data.error === 'string'
              ? data.error.slice(0, 500)
              : 'iframe 返回了无效截图',
          ))
        }
        return
      }

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
          pending.layoutIssues = []
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
        const pending = pendingCheckRef.current
        if (pending && !pending.done && documentId === pending.previousDocumentId) return
        captureDocumentRef.current = {
          id: documentId,
          width: Math.round(width),
          height: Math.round(height),
        }
        lastCaptureViewportRef.current = {
          width: Math.round(width),
          height: Math.round(height),
        }
        if (!pending || pending.done) return
        if (pending.diagnosticDocumentId !== documentId) {
          pending.diagnosticDocumentId = documentId
          pending.runtimeErrors = []
          pending.layoutIssues = []
        }
        pending.documentId = documentId
        beginRuntimeCollection()
      } else if (data.type === 'xiaozhu-server-layout') {
        const pending = pendingCheckRef.current
        if (
          !pending
          || pending.done
          || !Array.isArray(data.issues)
          || !prepareDiagnostics(pending)
        ) {
          return
        }
        for (const issue of data.issues) {
          const text = String(issue ?? '').trim().slice(0, 1000)
          if (
            text
            && pending.layoutIssues.length < 8
            && !pending.layoutIssues.includes(text)
          ) {
            pending.layoutIssues.push(text)
            pushPreviewLog({ level: 'warn', text })
          }
        }
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
    if (pendingCheckRef.current) pendingCheckRef.current.done = true
    pendingCheckRef.current = null
    clearCheckTimers()
    cancelPendingCaptures('预览面板已卸载')
    captureDocumentRef.current = null
  }, [cancelPendingCaptures, clearCheckTimers])

  const showIframe = previewStatus === 'ready' && Boolean(previewUrl)
  const previewHasIsolatedOrigin = Boolean(
    previewUrl
    && new URL(previewUrl, window.location.origin).origin !== window.location.origin,
  )
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
                sandbox={[
                  'allow-scripts',
                  'allow-forms',
                  'allow-modals',
                  ...(previewHasIsolatedOrigin ? ['allow-same-origin'] : []),
                ].join(' ')}
                referrerPolicy="no-referrer"
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
