import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore, type WCStatus, type LogLevel } from '@/store/ui'
import { bootAndRun, syncFiles, resetContainer, isBooted, isPreviewRunning } from '@/lib/webcontainer'
import { postBuildResult, reportBootResult, uploadPreviewScreenshot } from '@/lib/api'
import styles from './index.module.scss'

// iframe 内确认样式、字体、图片与 DOM 都稳定后，再额外收集一小段运行时错误。
const REVEAL_COLLECT_MS = 1500
// 兜底：万一新 document 始终不发 capture-ready（白屏/桥接失败），到点仍回报构建结果；
// 此分支不截旧 document，避免把上一版画面错误关联到本轮 check_build。
const REVEAL_FALLBACK_MS = 12000
// iframe 内部还会等字体/图片并执行 html2canvas；父页面再加一层硬超时，
// 截图失败时仍然正常回报编译/运行结果，不能拖死 check_build。
const CAPTURE_TIMEOUT_MS = 10000
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_SCREENSHOT_SIDE = 1280
const SCREENSHOT_MIMES = new Set(['image/webp', 'image/png', 'image/jpeg'])

type BuildCheckResult = {
  ok: boolean
  errors: string
  runtime: boolean
  visual: boolean
}

type RevealState = {
  checkId: string
  sessionId: string
  errors: string[]
  layoutIssues: string[]
  previousDocumentId: string | null
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
}

type PendingCapture = {
  documentId: string
  resolve: (screenshot: CapturedScreenshot) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ============================================
// 预览面板：WebContainer 真实预览
// - 首次进入 tab 才 boot（降低首屏开销）
// - boot 成功后 iframe 加载 vite preview（静态 dist）URL
// - 揭晓新代码时 syncFiles 重新 vite build，构建成功后整页刷新 iframe
// - 失败时回落到拟态占位（保留原视觉作为背景）
// ============================================
export default function PreviewPane() {
  const currentVersion = useSessionStore((s) => s.currentVersion())
  const hasCurrentFiles = Object.keys(currentVersion.files).length > 0
  // 当前会话 id —— 回传日志要带上它，后端按 session 分桶存
  const activeId = useSessionStore((s) => s.activeId)
  // 当前会话是否在流式生成中 —— 生成途中不自动构建预览（等 AI 调 check_build 揭晓）
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
  // 整页刷新预览（无 HMR，构建完新 dist 后靠它重载 iframe）
  const reloadPreview = useUIStore((s) => s.reloadPreview)
  // 应用请求：seq 变化即重新构建；checkId 把截图和回报绑定到对应 check_build 工具卡
  const applyRequest = useUIStore((s) => s.previewApplyRequest)
  // 导航指令（后退/前进/刷新）：seq 变化即把指令 postMessage 进 iframe
  const navCmd = useUIStore((s) => s.previewNavCmd)
  // 复位地址栏导航状态（切会话时用）
  const resetPreviewNav = useUIStore((s) => s.resetPreviewNav)

  // 标记上次同步的版本号，避免同 version 反复 sync
  const syncedVersionRef = useRef<string | null>(null)
  // 标记上次「应用」用到的 seq —— 区分「是新的 check_build 请求」还是
  // 「流式途中 version 变了但还没到揭晓时机」
  const appliedSeqRef = useRef(0)
  // 记住上次完整结果，并单独记录「编译是否通过」：运行/布局错误也会让 result.ok=false，
  // 但只有编译失败时才绝不能截取仍在 iframe 里的旧 dist。
  const lastBuildResultRef = useRef<BuildCheckResult>({
    ok: true, errors: '', runtime: false, visual: false,
  })
  const lastCompilationOkRef = useRef(true)
  // 容器当前归属哪个会话 —— 用来判断 activeId 变了要不要 teardown 重挂
  const containerSessionRef = useRef<string | null>(null)
  // 切会话时 files 常会稍后才拉到；两次 effect 共用同一个 reset Promise，保证新 boot
  // 一定排在旧容器 teardown 之后，不会因“空文件 → 文件到位”连续触发而并发启动。
  const containerResetRef = useRef<Promise<void> | null>(null)
  const ensureContainerReset = useCallback(() => {
    const current = containerResetRef.current
    if (current) return current
    const reset = resetContainer()
    containerResetRef.current = reset
    const clear = () => {
      if (containerResetRef.current === reset) containerResetRef.current = null
    }
    void reset.then(clear, clear)
    return reset
  }, [])
  // 当前 iframe 的引用，用于校验 postMessage 来源
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // —— 预览历史栈：父页面侧重建一份 iframe 内的浏览历史，用来算「能否前进/后退」——
  // iframe 跨域拿不到它真实的 history.length / 当前位置，只能靠导航桥上报的
  // push/replace/pop 事件在这里维护一个栈 + 游标。pop（前进后退）无法直接知道方向，
  // 通过比对目标路径是上一个还是下一个来推断。
  const histStackRef = useRef<string[]>([])
  const histIdxRef = useRef(-1)

  // activeId 放进 ref：下面的回调/定时器是在 effect 里建的闭包，
  // 直接读 activeId 会捕获到旧值，用 ref 保证拿到最新会话 id。
  const activeIdRef = useRef(activeId)
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // 回到空态会卸载整个 WorkArea，不会再有下一次 activeId effect 帮忙 teardown。
  // 卸载时主动失效并销毁容器，避免旧 boot 在后台继续占资源或迟到更新全局状态。
  useEffect(() => () => {
    // 必须登记同一 Promise：React StrictMode 会模拟 cleanup 后立刻重新 setup，
    // 下一次生命周期 effect 需要看到并等待这次 reset，不能误判容器仍可复用。
    void ensureContainerReset()
  }, [ensureContainerReset])

  // —— 揭晓收集：编译通过后，等新 iframe document 报 ready，再收集运行时/布局错误并回报 ——
  // revealRef 非空 = 正有一次 check_build 在等结果；documentId 让收集窗与截图都只认新产物。
  const revealRef = useRef<RevealState | null>(null)
  const revealCollectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // request id → Promise 收口；截图结果由统一的 window.message 监听器按 id 精确匹配。
  const pendingCaptureRef = useRef(new Map<string, PendingCapture>())
  // iframe 每次整页加载都会生成新 documentId。截图只认刚发过 ready 的那一份文档，
  // 既避免 build 后截到旧 dist，也避免迟到消息串到下一轮 check_build。
  const captureDocumentRef = useRef<CaptureDocument | null>(null)
  // 预览切到代码 tab / 移动端聊天页后 iframe 会变成 0×0；保留最近一次可见尺寸，
  // 离屏恢复时继续沿用相同响应式断点，避免“为了截图而改变页面布局”。
  const lastCaptureViewportRef = useRef<{ width: number; height: number } | null>(null)

  /** iframe 所在面板可能因「代码 tab / 移动端聊天视图」而 display:none。
   *  截图前把隐藏层临时移到屏幕外并恢复布局尺寸，完成后原样还原，用户不会看到闪动。 */
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

    // 移动端停在聊天视图时整个工作区被隐藏：先恢复 flex 布局并移到视口外。
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

    // 代码 tab 会单独隐藏预览 pane；让它离屏布局，避免覆盖用户当前正在看的代码。
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

  /** 向跨域 iframe 的指定 document 请求一张 viewport 截图。 */
  const captureIframeScreenshot = useCallback(async (
    expectedDocumentId: string,
  ): Promise<CapturedScreenshot> => {
    const iframe = iframeRef.current
    const win = iframe?.contentWindow
    if (!iframe || !win) throw new Error('预览 iframe 尚未就绪')
    if (captureDocumentRef.current?.id !== expectedDocumentId) {
      throw new Error('预览文档已经变化，取消过期截图')
    }

    const restoreLayout = prepareCaptureLayout()
    try {
      // 临时恢复隐藏面板后，等两帧让 iframe 获得稳定的 viewport 尺寸。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (iframe.clientWidth <= 1 || iframe.clientHeight <= 1) {
        throw new Error('预览面板当前没有可截图尺寸')
      }
      const readyDocument = captureDocumentRef.current
      if (readyDocument?.id !== expectedDocumentId) {
        throw new Error('预览文档尚未稳定')
      }
      lastCaptureViewportRef.current = {
        width: iframe.clientWidth,
        height: iframe.clientHeight,
      }

      const requestId =
        `capture-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      let targetOrigin: string
      try {
        targetOrigin = new URL(iframe.src).origin
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
          resolve,
          reject,
          timer,
        })
        try {
          win.postMessage({
            type: 'xiaozhu-capture-request',
            id: requestId,
            documentId: expectedDocumentId,
            // iframe 元素本身固定为白底；页面透明区域在真实预览里也显示为这个颜色。
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

  // 收尾一次揭晓：把收集到的运行时和布局错误打进 build-result，唤醒后端 check_build。
  // 截图是增强项：本地 blob 先让卡片即时出现，再上传换 id；任一步失败都照常回报结果。
  const finishReveal = useCallback(() => {
    const r = revealRef.current
    if (!r || r.done) return
    r.done = true
    if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
    if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
    revealCollectTimerRef.current = null
    revealFallbackTimerRef.current = null
    revealRef.current = null
    // 编译已通过；运行时、布局任一类别有问题都不能通过，并分别打标供 agent 判断。
    const errs = [...r.errors, ...r.layoutIssues]
    const result: BuildCheckResult = {
      ok: errs.length === 0,
      errors: errs.join('\n'),
      runtime: r.errors.length > 0,
      visual: r.layoutIssues.length > 0,
    }
    lastBuildResultRef.current = result

    void (async () => {
      let screenshotId: string | undefined
      try {
        // fallback 可能在 bridge ready 之前触发；这种情况只回报构建结果，绝不截旧页面。
        if (!r.documentId || captureDocumentRef.current?.id !== r.documentId) {
          throw new Error('本轮预览文档没有完成截图就绪校验')
        }
        const captured = await captureIframeScreenshot(r.documentId)
        const localUrl = URL.createObjectURL(captured.blob)
        useSessionStore.getState().setToolScreenshot(
          r.checkId,
          {
            id: `local-${r.checkId}`,
            url: localUrl,
            width: captured.width,
            height: captured.height,
            path: captured.path,
            mime: captured.mime,
            local: true,
          },
          r.sessionId,
        )
        const uploaded = await uploadPreviewScreenshot(
          r.sessionId,
          r.checkId,
          captured.blob,
          {
            width: captured.width,
            height: captured.height,
            path: captured.path,
          },
        )
        if (uploaded) {
          // 上传返回后先用持久化 ref 替换本地 blob；tool_result 再写同一份 ref 仍然幂等。
          // 卡片会在 props 切换时释放旧 URL，避免每次自检永久占用浏览器内存。
          useSessionStore.getState().setToolScreenshot(r.checkId, uploaded, r.sessionId)
        }
        screenshotId = uploaded?.id
      } catch (error) {
        // 截图自检是 best-effort；失败只写开发者日志，不把成功构建误判成失败。
        console.warn('预览截图失败', error)
      }

      await postBuildResult(r.sessionId, {
        check_id: r.checkId,
        ...result,
        ...(screenshotId ? { screenshot_id: screenshotId } : {}),
      })
    })()
  }, [captureIframeScreenshot])

  /** 为一次 check_build 架好运行时收集窗口；必须先调用再 reload iframe，避免漏掉首屏错误。 */
  const startReveal = useCallback((checkId: string, sessionId: string) => {
    if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
    if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
    revealRef.current = {
      checkId,
      sessionId,
      errors: [],
      layoutIssues: [],
      previousDocumentId: captureDocumentRef.current?.id ?? null,
      documentId: null,
      done: false,
    }
    // ready 消息兜底：到点仍未就绪就只回报构建/运行结果，不请求截图。
    revealFallbackTimerRef.current = setTimeout(finishReveal, REVEAL_FALLBACK_MS)
  }, [finishReveal])

  // —— 容器生命周期：让运行中的容器始终对应当前会话 ——
  // 首次启动、以及「切会话 / 开新会话」都走这里。切到不同会话时先 teardown
  // 旧容器再重新 boot+mount —— FS / dev server / 终端日志全部从零开始，绝不串台
  // （WebContainer 同一时刻只能有一个实例）。
  //
  // 等 files 到位再启动：files 从后端异步拉取，切换瞬间新会话的 files 还是空对象，
  // 此时 boot 会让 WebContainer 找不到 package.json 直接 ENOENT。
  useEffect(() => {
    const prevSession = containerSessionRef.current
    const sessionChanged = prevSession !== activeId
    // 容器已经服务于当前会话且在运行：交给下面的「切版本」effect 做增量同步
    if (!sessionChanged && isBooted() && !containerResetRef.current) return

    if (sessionChanged) {
      // files 尚未返回也要立刻切换归属并清空旧预览；等文件到位后的下一次 effect
      // 会复用同一个 reset Promise，再启动新会话。
      containerSessionRef.current = activeId
      histStackRef.current = []
      histIdxRef.current = -1
      resetPreviewNav()
      if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
      if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
      revealRef.current = null
      captureDocumentRef.current = null
      lastCaptureViewportRef.current = null
      lastCompilationOkRef.current = true
      lastBuildResultRef.current = {
        ok: true,
        errors: '',
        runtime: false,
        visual: false,
      }
    }

    const bootSessionId = activeId
    const bootFiles = currentVersion.files
    const bootVersionId = currentVersion.id
    let cancelled = false
    ;(async () => {
      // 切到了不同会话：销毁旧容器 + 清空两处日志面板
      if (isBooted() && prevSession !== activeId) {
        setWCStatus('booting')
        setWCUrl(null)
        const reset = ensureContainerReset()
        await reset
        clearWcLogs()
      } else if (containerResetRef.current) {
        // 上一次“会话已切换但 files 还没返回”的 effect 已发起 reset；必须等它完成。
        await containerResetRef.current
      }
      if (cancelled || !hasCurrentFiles || !bootSessionId) return
      if (containerSessionRef.current !== bootSessionId) return

      syncedVersionRef.current = null
      setWCError(null)
      await bootAndRun(bootFiles, {
        onStatus: setWCStatus,
        onUrl: setWCUrl,
        onLog: setWCLog,
        onError: setWCError,
        // boot / 启动失败：上报后端供管理后台监控（best-effort，静默）。
        // crossOriginIsolated 为 false 说明 COOP/COEP 没生效（必然 boot 失败），是重要线索。
        onBootFail: (info) => {
          reportBootResult({
            session_id: bootSessionId,
            stage: info.stage,
            kind: info.kind,
            message: info.message,
            cross_origin_isolated:
              typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : undefined,
            elapsed_ms: info.elapsedMs,
            cold: info.cold,
          })
        },
        // boot 成功：上报成功耗时（kind='ok'），带冷/热标记，供后台统计 boot 耗时分布。
        onBootOk: (info) => {
          reportBootResult({
            session_id: bootSessionId,
            stage: 'booting',
            kind: 'ok',
            cross_origin_isolated:
              typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : undefined,
            elapsed_ms: info.elapsedMs,
            cold: info.cold,
          })
        },
      })
      if (cancelled) return
      if (containerSessionRef.current !== bootSessionId) return
      syncedVersionRef.current = bootVersionId
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, hasCurrentFiles])

  // —— 把文件变更同步进容器并重新构建预览（无 HMR，构建成功后整页刷新 iframe）——
  // 触发来源有两类：
  //   1. 流式生成途中：AI 调 check_build → applyRequest.seq 自增 → 揭晓并构建一次完整改动；
  //      本轮结束（isStreaming 翻 false 让本 effect 重跑）→ 兜底构建最终态。
  //   2. 非流式：回滚版本等场景，version 一变就直接构建。
  // 流式途中每个 file_write 都会 bump version，但我们故意不跟着构建 ——
  // 否则会把半成品（甚至构建失败的中间态）闪给用户，也白白浪费多次全量构建。
  useEffect(() => {
    if (!isPreviewRunning()) return
    // 只构建「当前会话自己的」版本变更；切会话的重挂由上面的 effect 负责，
    // 这里若不挡住，会把新会话的文件 sync 进尚未销毁的旧容器。
    if (containerSessionRef.current !== activeId) return
    if (!activeId) return
    const buildSessionId = activeId

    // 是不是「新的 check_build 揭晓请求」（seq 变了）。AI 每次调 check_build 都会
    // 携带自己的 tool_call_id —— 这种请求【必须】按同一个 id 回报一次 build-result，否则
    // 会一直等到超时。版本变更（回滚等）则不需要回报（没有 check_build 在等）。
    // 还要核对所属会话：切换后留在 UI store 里的旧请求不能触发新项目构建。
    const isReveal = (
      applyRequest.seq !== appliedSeqRef.current
      && applyRequest.sessionId === buildSessionId
    )
    const checkId = isReveal ? applyRequest.checkId : null
    // 流式途中、非揭晓 → 暂不构建，保持上一个稳定态
    if (isStreaming && !isReveal) return

    // 版本没变也要对每次 check_build 重新截图：编译通过过就重载当前 dist，重新收集
    // 运行时错误并截一张新图；上次编译失败则绝不截旧 dist，直接回报原错误。
    if (syncedVersionRef.current === currentVersion.id) {
      if (isReveal) {
        appliedSeqRef.current = applyRequest.seq
        if (!checkId) return
        if (lastCompilationOkRef.current) {
          startReveal(checkId, buildSessionId)
          reloadPreview()
        } else {
          void postBuildResult(buildSessionId, {
            check_id: checkId,
            ...lastBuildResultRef.current,
          })
        }
      }
      return
    }
    appliedSeqRef.current = applyRequest.seq

    setWCStatus('syncing')
    syncFiles(currentVersion.files, { onLog: setWCLog })
      .then((res) => {
        // syncFiles 不能中途 abort；切换会话会 teardown 旧容器。旧 Promise 即使稍后
        // settle，也不允许再刷新新 iframe、覆盖状态或向旧 check_build 回报结果。
        if (
          activeIdRef.current !== buildSessionId
          || containerSessionRef.current !== buildSessionId
        ) return
        syncedVersionRef.current = currentVersion.id
        setWCStatus('ready')
        if (res.buildOk) {
          // 编译通过先记个基线（运行时这轮的话由 finishReveal 稍后覆盖成真实结果）
          lastCompilationOkRef.current = true
          lastBuildResultRef.current = { ok: true, errors: '', runtime: false, visual: false }
          // 先架好「运行时错误收集」，再整页刷新 iframe 加载新 dist。build-result 不在这里
          // 立刻发 —— 要等 iframe 重载渲染、收集完运行时错误，由 finishReveal 带着「编译 +
          // 运行」结果一并回报（见 capture-ready / 收集窗）。
          if (isReveal && checkId) startReveal(checkId, buildSessionId)
          reloadPreview()
        } else {
          // 编译失败：【不】刷新，保留上一个能跑的产物；错误显示到控制台「浏览器」面板，
          // 并立刻回报（编译错确定，无需等渲染）。
          lastCompilationOkRef.current = false
          const result: BuildCheckResult = {
            ok: false,
            errors: res.buildError ?? '',
            runtime: false,
            visual: false,
          }
          lastBuildResultRef.current = result
          if (res.buildError) pushWcLog({ level: 'error', text: res.buildError })
          if (isReveal && checkId) {
            void postBuildResult(buildSessionId, { check_id: checkId, ...result })
          }
        }
      })
      .catch((e) => {
        if (
          activeIdRef.current !== buildSessionId
          || containerSessionRef.current !== buildSessionId
        ) return
        const msg = e instanceof Error ? e.message : String(e)
        setWCError(msg)
        setWCStatus('error')
        lastCompilationOkRef.current = false
        const result: BuildCheckResult = {
          ok: false,
          errors: msg,
          runtime: false,
          visual: false,
        }
        lastBuildResultRef.current = result
        // 同步/构建本身抛异常（容器挂了等）也要回报，否则 check_build 同样会干等。
        if (isReveal && checkId) {
          void postBuildResult(buildSessionId, { check_id: checkId, ...result })
        }
      })
  }, [
    activeId,
    currentVersion.id,
    currentVersion.files,
    applyRequest.seq,
    applyRequest.checkId,
    applyRequest.sessionId,
    isStreaming,
    wcUrl,
    setWCStatus,
    setWCLog,
    setWCError,
    reloadPreview,
    pushWcLog,
    startReveal,
  ])

  // —— 浏览器桥接：iframe → 父页面 ——
  // console 桥把日志推到控制台；布局桥把浏览器实测的基础响应式问题攒进 revealRef，
  // 两类问题最终一并回报给 agent。不再单独往后端推日志（log_store 已废）。
  useEffect(() => {
    const pendingCaptures = pendingCaptureRef.current
    const handle = (e: MessageEvent) => {
      const data = e.data
      if (!data) return
      // iframe 必须仍存在，WindowProxy 与 origin 都要和当前 src 对得上：
      // 重载前的迟到消息、以及预览若被业务代码导航到其它站点后的伪造消息一律丢弃。
      const frame = iframeRef.current
      const frameWindow = frame?.contentWindow
      if (!frame || !frameWindow || e.source !== frameWindow) return
      try {
        if (e.origin !== new URL(frame.src).origin) return
      } catch {
        return
      }

      // —— 文档就绪：只有 iframe 内确认资源与 DOM 稳定后，才启动本轮截图收集窗 ——
      if (data.type === 'xiaozhu-capture-ready') {
        const documentId =
          typeof data.documentId === 'string' && data.documentId.length <= 160
            ? data.documentId
            : ''
        const width = Number(data.width)
        const height = Number(data.height)
        if (
          !documentId ||
          !Number.isFinite(width) ||
          width < 1 ||
          width > 20000 ||
          !Number.isFinite(height) ||
          height < 1 ||
          height > 20000
        ) {
          return
        }
        if (width > 1 && height > 1) {
          lastCaptureViewportRef.current = {
            width: Math.round(width),
            height: Math.round(height),
          }
        }
        const readyDocument: CaptureDocument = {
          id: documentId,
          width: Math.round(width),
          height: Math.round(height),
        }

        const r = revealRef.current
        // 本轮 reload 之前那份文档的迟到 ready 必须在更新全局引用前丢弃，否则会让
        // 已经开始的新文档截图在 finishReveal 时被误判为过期。
        if (r && !r.done && documentId === r.previousDocumentId) return
        captureDocumentRef.current = readyDocument
        if (!r || r.done) return
        // 极窄竞态下旧文档可能先发一条迟到 ready，新文档随后再发；始终以最新文档为准，
        // 并从它的 ready 时刻重新计算收集窗。
        r.documentId = documentId
        if (revealFallbackTimerRef.current) {
          clearTimeout(revealFallbackTimerRef.current)
          revealFallbackTimerRef.current = null
        }
        if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
        revealCollectTimerRef.current = setTimeout(finishReveal, REVEAL_COLLECT_MS)
        return
      }

      // —— 截图结果：按 request id 收口 Promise，ArrayBuffer 直接包成 Blob ——
      if (data.type === 'xiaozhu-capture-result') {
        const requestId = typeof data.id === 'string' ? data.id : ''
        const pending = pendingCaptures.get(requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingCaptures.delete(requestId)
        if (
          data.documentId === pending.documentId &&
          captureDocumentRef.current?.id === pending.documentId &&
          data.ok === true &&
          data.bytes instanceof ArrayBuffer &&
          data.bytes.byteLength > 0 &&
          data.bytes.byteLength <= MAX_SCREENSHOT_BYTES &&
          typeof data.mime === 'string' &&
          SCREENSHOT_MIMES.has(data.mime) &&
          typeof data.width === 'number' &&
          Number.isFinite(data.width) &&
          data.width > 0 &&
          data.width <= MAX_SCREENSHOT_SIDE &&
          typeof data.height === 'number' &&
          Number.isFinite(data.height) &&
          data.height > 0 &&
          data.height <= MAX_SCREENSHOT_SIDE
        ) {
          const mime = data.mime
          pending.resolve({
            blob: new Blob([data.bytes], { type: mime }),
            width: Math.max(1, Math.round(data.width)),
            height: Math.max(1, Math.round(data.height)),
            path: typeof data.path === 'string' ? data.path.slice(0, 2048) : '/',
            mime,
          })
        } else {
          pending.reject(new Error(
            typeof data.error === 'string' ? data.error : 'iframe 截图失败',
          ))
        }
        return
      }

      // —— 路由导航上报：维护历史栈，更新地址栏 + 前进后退可用态 ——
      if (data.type === 'xiaozhu-nav') {
        const path = typeof data.path === 'string' ? data.path : '/'
        const stack = histStackRef.current
        let idx = histIdxRef.current
        if (data.kind === 'init') {
          // 整页加载（首次 / location.reload）：重置成单条历史
          histStackRef.current = [path]
          idx = 0
        } else if (data.kind === 'replace') {
          // 替换当前条目（如 <Navigate replace>），不增长历史
          if (idx >= 0) stack[idx] = path
          else { histStackRef.current = [path]; idx = 0 }
        } else if (data.kind === 'pop') {
          // 前进/后退：popstate 不带方向，比对目标是上一条还是下一条来推断
          if (idx > 0 && stack[idx - 1] === path) idx -= 1
          else if (idx < stack.length - 1 && stack[idx + 1] === path) idx += 1
          else { const t = stack.slice(0, idx + 1); t.push(path); histStackRef.current = t; idx = t.length - 1 }
        } else {
          // push（含未知类型兜底）：截掉游标之后的「前进分支」，压入新路径
          const t = stack.slice(0, idx + 1)
          t.push(path)
          histStackRef.current = t
          idx = t.length - 1
        }
        histIdxRef.current = idx
        const len = histStackRef.current.length
        // 用 getState 直接写，避免把 setter 加进 effect 依赖反复重订阅
        useUIStore.getState().setPreviewNav({ path, canBack: idx > 0, canForward: idx < len - 1 })
        return
      }

      if (data.type === 'xiaozhu-layout') {
        const r = revealRef.current
        if (!r || r.done || !Array.isArray(data.issues)) return
        for (const issue of data.issues) {
          const text = String(issue ?? '').trim()
          if (text && r.layoutIssues.length < 8 && !r.layoutIssues.includes(text)) {
            r.layoutIssues.push(text)
          }
        }
        return
      }

      if (data.type !== 'xiaozhu-console') return
      const level: LogLevel = ['log', 'info', 'warn', 'error'].includes(data.level) ? data.level : 'log'
      const text = String(data.text ?? '')
      pushWcLog({ level, text })

      // 揭晓收集中：把渲染期间抛的 error 攒进 revealRef，供 finishReveal 回报给 agent。
      // 去重 + 限量：一次渲染崩溃常连刷好几条（React 会打错误 + 组件栈），别撑爆 payload。
      if (level === 'error') {
        const r = revealRef.current
        if (r && !r.done && r.errors.length < 8 && !r.errors.includes(text)) {
          r.errors.push(text)
        }
      }
    }

    window.addEventListener('message', handle)
    return () => {
      window.removeEventListener('message', handle)
      // 卸载时清掉可能在跑的揭晓收集定时器
      if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
      if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
      for (const pending of pendingCaptures.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('预览面板已卸载'))
      }
      pendingCaptures.clear()
    }
  }, [finishReveal, pushWcLog])

  // —— 把导航指令（后退/前进/刷新）postMessage 进 iframe ——
  // 只有本组件持有 iframe 引用，所以 TabBar 的按钮通过 store 的 previewNavCmd
  // 计数器间接触发这里。seq=0 是初始值，跳过。
  useEffect(() => {
    if (navCmd.seq === 0) return
    const win = iframeRef.current?.contentWindow
    if (!win) return
    win.postMessage({ type: 'xiaozhu-nav-cmd', action: navCmd.action }, '*')
  }, [navCmd])

  // ready 时延迟 900ms 再显示 iframe，让进度条动画有时间跑到 100%
  // syncing 是「同步文件 + 重新构建」阶段，iframe 暂保持可见（展示上一个产物），
  // 构建成功后会整页刷新换上新 dist
  const [iframeVisible, setIframeVisible] = useState(false)
  useEffect(() => {
    if (wcStatus === 'ready' && wcUrl) {
      const t = setTimeout(() => setIframeVisible(true), 900)
      return () => clearTimeout(t)
    } else if (wcStatus !== 'syncing') {
      const t = setTimeout(() => setIframeVisible(false), 0)
      return () => clearTimeout(t)
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
  building:   80,
  starting:   88,
  ready:      100,
}

// 每个阶段展示给用户的描述文案
const STATUS_LABEL: Record<string, string> = {
  booting:    '正在启动运行环境…',
  mounting:   '正在写入项目文件…',
  installing: '正在准备依赖包…',
  building:   '正在构建预览产物…',
  starting:   '正在启动预览服务…',
  ready:      '即将完成…',
}

// 某阶段卡过这个时长（ms）还没推进，就显示「慢加载提示」安抚用户 + 给排查方向。
// 只给真正可能久等的两个阶段配：
//   booting   —— WebContainer 运行时要从境外 CDN（StackBlitz）下载，国内首次最慢。
//   installing —— 首次要下依赖快照（几 MB），也可能要等一会儿。
const SLOW_HINT_AFTER: Record<string, number> = {
  booting: 15000,
  installing: 30000,
}
const SLOW_HINT: Record<string, string> = {
  booting:
    '运行环境需从境外 CDN（StackBlitz）下载，国内网络首次可能要等一两分钟。' +
    '若长时间卡住：检查网络、关闭浏览器开发者工具里的「停用缓存」让它能缓存住、或走代理后重试。',
  installing: '首次准备依赖较慢（要下载依赖快照），请再稍候…',
}

function BootingBlock({ status, log }: { status: WCStatus; log: string }) {
  const target = STATUS_PROGRESS[status] ?? 0
  const label = STATUS_LABEL[status] ?? '正在加载…'

  // 卡太久才显示的慢加载提示：每次进入新阶段先清掉，超过该阶段阈值再亮出来
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const resetTimer = setTimeout(() => setSlow(false), 0)
    const after = SLOW_HINT_AFTER[status]
    if (!after) return () => clearTimeout(resetTimer)
    const timer = setTimeout(() => setSlow(true), after)
    return () => {
      clearTimeout(resetTimer)
      clearTimeout(timer)
    }
  }, [status])

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
      {slow && SLOW_HINT[status] && <p className={styles.slowHint}>{SLOW_HINT[status]}</p>}
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
