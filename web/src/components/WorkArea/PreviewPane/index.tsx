import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useUIStore, type WCStatus, type LogLevel } from '@/store/ui'
import { bootAndRun, syncFiles, resetContainer, isBooted, isPreviewRunning } from '@/lib/webcontainer'
import { postBuildResult, reportBootResult } from '@/lib/api'
import styles from './index.module.scss'

// 编译通过后，iframe 重载渲染期间收集运行时错误的窗口（从 iframe load 事件起算）。
// 渲染崩溃几乎在 load 后立刻抛，这点时间足够接住；窗口一结束就带着错误回报 build-result。
const REVEAL_COLLECT_MS = 1500
// 兜底：万一 iframe 的 load 事件始终不来（白屏/加载失败），到点也强制回报，
// 别让后端 check_build 一直等到 90s 超时。
const REVEAL_FALLBACK_MS = 6000

// ============================================
// 预览面板：WebContainer 真实预览
// - 首次进入 tab 才 boot（降低首屏开销）
// - boot 成功后 iframe 加载 vite preview（静态 dist）URL
// - 揭晓新代码时 syncFiles 重新 vite build，构建成功后整页刷新 iframe
// - 失败时回落到拟态占位（保留原视觉作为背景）
// ============================================
export default function PreviewPane() {
  const currentVersion = useSessionStore((s) => s.currentVersion())
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
  // 应用计数器：变化即把当前暂存文件同步进容器并重新构建（AI 调 check_build 时自增）
  const applyTick = useUIStore((s) => s.previewApplyTick)
  // 导航指令（后退/前进/刷新）：seq 变化即把指令 postMessage 进 iframe
  const navCmd = useUIStore((s) => s.previewNavCmd)
  // 复位地址栏导航状态（切会话时用）
  const resetPreviewNav = useUIStore((s) => s.resetPreviewNav)

  // 标记上次同步的版本号，避免同 version 反复 sync
  const syncedVersionRef = useRef<string | null>(null)
  // 标记上次「应用」用到的 applyTick —— 区分「是新的 check_build 请求」还是
  // 「流式途中 version 变了但还没到揭晓时机」
  const appliedTickRef = useRef(0)
  // 记住上次【回报过】的完整结果（含运行时）—— 用于「版本没变但 AI 又调了一次 check_build」时，
  // 无需重新构建即可把上次结果原样回报，免得后端 check_build 干等到超时。
  const lastBuildResultRef = useRef<{ ok: boolean; errors: string; runtime: boolean }>({
    ok: true, errors: '', runtime: false,
  })
  // 容器当前归属哪个会话 —— 用来判断 activeId 变了要不要 teardown 重挂
  const containerSessionRef = useRef<string | null>(null)
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
  activeIdRef.current = activeId

  // —— 揭晓收集：编译通过后，等 iframe 重载渲染、收集运行时错误，再回报 build-result ——
  // revealRef 非空 = 正有一次 check_build 揭晓在等结果。iframe load 后开收集窗，
  // 窗内 console 桥抓到的运行时报错攒进 errors，窗结束就带着它们一起回报。
  const revealRef = useRef<{ errors: string[]; started: boolean; done: boolean } | null>(null)
  const revealCollectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 收尾一次揭晓：把收集到的运行时错误打进 build-result 回报，唤醒后端 check_build。
  // 只用 ref，所以 useCallback([]) 稳定，可安全进各 effect 依赖。
  const finishReveal = useCallback(() => {
    const r = revealRef.current
    if (!r || r.done) return
    r.done = true
    if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
    if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
    revealCollectTimerRef.current = null
    revealFallbackTimerRef.current = null
    revealRef.current = null
    // 编译已通过；有运行时错误 → ok=false + runtime=true，否则一切正常。
    const errs = r.errors
    const result = { ok: errs.length === 0, errors: errs.join('\n'), runtime: errs.length > 0 }
    lastBuildResultRef.current = result  // 记下真实结果（含运行时），供「重复 check_build」原样复用
    const sid = activeIdRef.current
    if (sid) postBuildResult(sid, result)
  }, [])

  // iframe 加载完(渲染开始)：若正有揭晓在等，开一个短收集窗，窗结束回报。
  const handleIframeLoad = useCallback(() => {
    const r = revealRef.current
    if (!r || r.started || r.done) return
    r.started = true
    revealCollectTimerRef.current = setTimeout(finishReveal, REVEAL_COLLECT_MS)
  }, [finishReveal])

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
    // 复位地址栏 / 前进后退栈 —— 新会话从 '/' 重新开始，等 iframe 里的导航桥
    // 重新上报 init 再填回去
    histStackRef.current = []
    histIdxRef.current = -1
    resetPreviewNav()
    // 清掉进行中的揭晓收集，避免把上个会话的运行时错误回报到新会话
    if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
    if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
    revealRef.current = null

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
        // boot / 启动失败：上报后端供管理后台监控（best-effort，静默）。
        // crossOriginIsolated 为 false 说明 COOP/COEP 没生效（必然 boot 失败），是重要线索。
        onBootFail: (info) => {
          reportBootResult({
            session_id: activeIdRef.current,
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
            session_id: activeIdRef.current,
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
      syncedVersionRef.current = currentVersion.id
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, currentVersion.files])

  // —— 把文件变更同步进容器并重新构建预览（无 HMR，构建成功后整页刷新 iframe）——
  // 触发来源有两类：
  //   1. 流式生成途中：AI 调 check_build → applyTick 自增 → 揭晓并构建一次完整改动；
  //      本轮结束（isStreaming 翻 false 让本 effect 重跑）→ 兜底构建最终态。
  //   2. 非流式：回滚版本等场景，version 一变就直接构建。
  // 流式途中每个 file_write 都会 bump version，但我们故意不跟着构建 ——
  // 否则会把半成品（甚至构建失败的中间态）闪给用户，也白白浪费多次全量构建。
  useEffect(() => {
    if (!isPreviewRunning()) return
    // 只构建「当前会话自己的」版本变更；切会话的重挂由上面的 effect 负责，
    // 这里若不挡住，会把新会话的文件 sync 进尚未销毁的旧容器。
    if (containerSessionRef.current !== activeId) return

    // 是不是「新的 check_build 揭晓请求」（applyTick 变了）。AI 每次调 check_build 都会
    // 让 applyTick 自增 —— 这种请求【必须】回报一次 build-result，否则后端 check_build
    // 会一直等到超时。版本变更（回滚等）则不需要回报（没有 check_build 在等）。
    const isReveal = applyTick !== appliedTickRef.current
    // 流式途中、非揭晓 → 暂不构建，保持上一个稳定态
    if (isStreaming && !isReveal) return

    // 版本没变 → 不用重新构建。但若这是一次 check_build 揭晓请求，仍要把上次构建结果
    // 回报给后端（沿用 lastBuildResultRef），唤醒在等的 check_build，别让它干等到超时。
    if (syncedVersionRef.current === currentVersion.id) {
      if (isReveal) {
        appliedTickRef.current = applyTick
        // 没重新构建 → 把上次回报过的完整结果原样再报一次（含运行时态）
        if (activeId) postBuildResult(activeId, lastBuildResultRef.current)
      }
      return
    }
    appliedTickRef.current = applyTick

    setWCStatus('syncing')
    syncFiles(currentVersion.files, { onLog: setWCLog })
      .then((res) => {
        syncedVersionRef.current = currentVersion.id
        setWCStatus('ready')
        if (res.buildOk) {
          // 编译通过先记个基线（运行时这轮的话由 finishReveal 稍后覆盖成真实结果）
          lastBuildResultRef.current = { ok: true, errors: '', runtime: false }
          // 先架好「运行时错误收集」，再整页刷新 iframe 加载新 dist。build-result 不在这里
          // 立刻发 —— 要等 iframe 重载渲染、收集完运行时错误，由 finishReveal 带着「编译 +
          // 运行」结果一并回报（见 handleIframeLoad / 收集窗）。
          if (isReveal && activeId) {
            if (revealCollectTimerRef.current) clearTimeout(revealCollectTimerRef.current)
            if (revealFallbackTimerRef.current) clearTimeout(revealFallbackTimerRef.current)
            revealRef.current = { errors: [], started: false, done: false }
            // load 事件兜底：万一 iframe 始终不 load，到点也回报，别让 check_build 干等。
            revealFallbackTimerRef.current = setTimeout(finishReveal, REVEAL_FALLBACK_MS)
          }
          reloadPreview()
        } else {
          // 编译失败：【不】刷新，保留上一个能跑的产物；错误显示到控制台「浏览器」面板，
          // 并立刻回报（编译错确定，无需等渲染）。
          lastBuildResultRef.current = { ok: false, errors: res.buildError ?? '', runtime: false }
          if (res.buildError) pushWcLog({ level: 'error', text: res.buildError })
          if (isReveal && activeId) postBuildResult(activeId, lastBuildResultRef.current)
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setWCError(msg)
        setWCStatus('error')
        // 同步/构建本身抛异常（容器挂了等）也要回报，否则 check_build 同样会干等。
        if (isReveal && activeId) postBuildResult(activeId, { ok: false, errors: msg, runtime: false })
      })
  }, [activeId, currentVersion.id, currentVersion.files, applyTick, isStreaming, setWCStatus, setWCLog, setWCError, reloadPreview, pushWcLog, finishReveal])

  // —— 浏览器 console 桥接：iframe → 父页面 ——
  // iframe 里注入的脚本会 postMessage({ type: 'xiaozhu-console', level, text })，
  // 这里挂全局监听：推到控制台面板（给人看）；揭晓收集中时，error 还攒进 revealRef
  // 供 build-result 回报（给 agent 看）。不再单独往后端推日志（log_store 已废）。
  useEffect(() => {
    const handle = (e: MessageEvent) => {
      const data = e.data
      if (!data) return
      // 来源校验：必须来自当前 iframe 的 contentWindow，防止其他 tab 的脏数据
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return

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
    }
  }, [pushWcLog])

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
                onLoad={handleIframeLoad}
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
    setSlow(false)
    const after = SLOW_HINT_AFTER[status]
    if (!after) return
    const timer = setTimeout(() => setSlow(true), after)
    return () => clearTimeout(timer)
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
