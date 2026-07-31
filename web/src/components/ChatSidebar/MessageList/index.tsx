import { useEffect, useRef, useState } from 'react'
import { MessageSquare, RotateCcw } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { formatDuration } from '@/lib/format'
import type { Message } from '@/types/project'
import MessageBubble from '../MessageBubble'
import styles from './index.module.scss'

// 首次进入会话时，等右侧预览区的 fade-up 展开动画（0.6s）放完、布局稳定后再滚到底。
// 否则在动画/布局还没稳的时候滚，会滚不到最底。留一点余量取 700ms。
const INIT_SCROLL_DELAY = 700

// 距离底部在这个范围内视为用户已经主动回到底部，可恢复自动跟随。
const FOLLOW_BOTTOM_THRESHOLD = 8

// 「正在生成」等了这么多秒还没出内容，就补一句耐心提示 + 亮出计时。
// 部分模型（如推理型 Gemini）会先思考几十秒才吐第一个字，且中转不回传思维链 ——
// 期间界面只有 shimmer 容易被当成卡死，这里用「秒数在走」证明它还在干活。
const SLOW_GEN_HINT_AFTER = 6

type Props = {
  /** 重试最新一轮的回调（由 ChatSidebar 提供，内部走流式重生成） */
  onRetry?: () => void
  /** ask_user 交互卡片答完的回调（由 ChatSidebar 提供），原样透传给每条消息 */
  onAskUserAnswer?: (message: Message, answer: string) => Promise<void>
}

// ============================================
// 对话列表：渲染当前会话消息 + 流式输出中的 AI 消息
// ============================================
export default function MessageList({ onRetry, onAskUserAnswer }: Props) {
  const session = useSessionStore((s) => s.activeSession())
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // 用户手动离开底部后暂停自动跟随；只有再次滚回底部才恢复。
  const shouldFollowRef = useRef(true)
  // scroll 事件本身分不出「用户滚动」和「聊天栏变窄导致文本换行」。
  // 只有先收到明确的滚轮 / 触摸 / 滚动条操作，才允许 scroll 事件暂停跟随。
  const userScrollIntentRef = useRef(false)
  // 记录已经为哪个会话做过「首次定位到底部」。首次（刷新 / 切会话）延时滚，
  // 避开预览区展开动画 + 布局抖动；之后的新消息才即时 smooth 平滑滚动。
  const didInitScrollRef = useRef<string | null>(null)

  // 新版后端不会再保存无正文的思考卡；这里继续过滤历史遗留的 fallback / 空消息，
  // 保证只有模型真实返回了推理文本时，时间线才展示“思考过程”。
  const messages = (session?.messages ?? []).filter(
    (message) => (
      message.kind !== 'reasoning' ||
      (
        message.reasoningFallback !== true &&
        (message.reasoningStreaming || message.text.trim().length > 0)
      )
    ),
  )
  const isStreaming = session?.isStreaming ?? false
  // 历史消息是异步加载的：sessionId 可能先出现，消息列表稍后才真正挂载。
  // 这个标记用于在 listRef 从不存在变为可用时重新安装滚动监听。
  const hasMessageList = messages.length > 0 || isStreaming
  const sessionId = session?.id ?? null
  // 本轮流式已累积的文本：非空 = 已经在吐字了，就不再显示「思考中」计时提示。
  const streamingText = session?.streamingText ?? ''
  // 厂商正在回传真实推理正文时，由思考卡自身展示流式状态，不再叠一层通用计时提示。
  const liveReasoning = [...messages].reverse().find(
    (m) => m.kind === 'reasoning' && m.reasoningStreaming,
  )
  const liveReasoningTextLength = liveReasoning?.text.length ?? 0
  const hasLiveReasoning = liveReasoning !== undefined
  // 最新工具卡：用于判断当前这段「静默等待」到底是在构建、修复，还是已经构建完等模型总结。
  // 注意：工具卡的 result 是异步回填的，下面的 phaseKey 会把「工具刚出现」和「工具有结果」
  // 当成两个阶段，计时也跟着重置，避免把整轮累计时间误显示成当前卡住时间。
  const latestTool = [...messages].reverse().find((m) => m.kind === 'tool')
  const latestToolResult = latestTool?.toolResult ?? ''
  const phaseKey = [
    sessionId,
    messages.length,
    latestTool?.toolCallId ?? '',
    latestTool?.toolName ?? '',
    latestToolResult ? 'result' : 'pending',
  ].join(':')

  // 当前阶段静默持续了多少秒。进入新的工具/工具结果阶段时会重置，
  // 避免把整轮累计耗时误显示成当前卡住时间。
  const [genSeconds, setGenSeconds] = useState(0)
  useEffect(() => {
    if (!isStreaming || streamingText || hasLiveReasoning) {
      const resetTimer = setTimeout(() => setGenSeconds(0), 0)
      return () => clearTimeout(resetTimer)
    }
    const started = Date.now()
    const resetTimer = setTimeout(() => setGenSeconds(0), 0)
    const timer = setInterval(() => {
      setGenSeconds(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      clearTimeout(resetTimer)
      clearInterval(timer)
    }
  }, [isStreaming, streamingText, hasLiveReasoning, phaseKey])

  // 监听真正承载滚动的 chatBody。用户向上查看历史消息后立刻暂停自动跟随，
  // 滚回底部时再恢复；聊天栏宽度变化引起的内容重排则继续贴底。
  useEffect(() => {
    const scrollContainer = listRef.current?.parentElement
    const list = listRef.current
    if (!scrollContainer || !list) return

    shouldFollowRef.current = true
    userScrollIntentRef.current = false

    const isNearBottom = () => {
      const distanceToBottom = (
        scrollContainer.scrollHeight
        - scrollContainer.scrollTop
        - scrollContainer.clientHeight
      )
      return distanceToBottom <= FOLLOW_BOTTOM_THRESHOLD
    }

    const syncFollowState = () => {
      if (isNearBottom()) {
        shouldFollowRef.current = true
      } else if (userScrollIntentRef.current) {
        shouldFollowRef.current = false
      }
      userScrollIntentRef.current = false
    }

    let intentResetTimer = 0
    const expireTransientIntent = () => {
      window.clearTimeout(intentResetTimer)
      intentResetTimer = window.setTimeout(() => {
        userScrollIntentRef.current = false
      }, 150)
    }
    const markWheelIntent = (event: WheelEvent) => {
      userScrollIntentRef.current = true
      expireTransientIntent()
      // 向上滚时立即暂停，避免同一帧的新流式内容先把用户拉回底部。
      if (event.deltaY < 0) shouldFollowRef.current = false
    }
    const markTouchIntent = () => {
      userScrollIntentRef.current = true
    }
    const markPointerIntent = (event: PointerEvent) => {
      // 点击消息里的按钮不算滚动意图；只有直接操作滚动容器（含原生滚动条）才算。
      if (event.target === scrollContainer) {
        userScrollIntentRef.current = true
      }
    }
    const clearPointerIntent = () => {
      userScrollIntentRef.current = false
    }
    const markKeyboardIntent = (event: KeyboardEvent) => {
      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || activeElement instanceof HTMLSelectElement
        || (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      ) {
        return
      }

      const scrollKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']
      if (!scrollKeys.includes(event.key)) return
      userScrollIntentRef.current = true
      expireTransientIntent()
      if (
        event.key === 'ArrowUp'
        || event.key === 'PageUp'
        || event.key === 'Home'
        || (event.key === ' ' && event.shiftKey)
      ) {
        shouldFollowRef.current = false
      }
    }

    // 首次预览展开时 sidebar 有宽度动画，文本会持续换行、scrollHeight 逐帧增长。
    // 只要用户没有主动离开底部，就在每次尺寸变化后继续贴住最新消息。
    let resizeFrame = 0
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!shouldFollowRef.current) return
          cancelAnimationFrame(resizeFrame)
          resizeFrame = requestAnimationFrame(() => {
            if (!shouldFollowRef.current) return
            scrollContainer.scrollTop = scrollContainer.scrollHeight
          })
        })

    resizeObserver?.observe(scrollContainer)
    resizeObserver?.observe(list)

    scrollContainer.addEventListener('wheel', markWheelIntent, { passive: true })
    scrollContainer.addEventListener('touchstart', markTouchIntent, { passive: true })
    scrollContainer.addEventListener('pointerdown', markPointerIntent)
    window.addEventListener('pointerup', clearPointerIntent)
    window.addEventListener('pointercancel', clearPointerIntent)
    window.addEventListener('keydown', markKeyboardIntent)

    scrollContainer.addEventListener('scroll', syncFollowState, { passive: true })
    return () => {
      window.clearTimeout(intentResetTimer)
      cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      scrollContainer.removeEventListener('wheel', markWheelIntent)
      scrollContainer.removeEventListener('touchstart', markTouchIntent)
      scrollContainer.removeEventListener('pointerdown', markPointerIntent)
      scrollContainer.removeEventListener('scroll', syncFollowState)
      window.removeEventListener('pointerup', clearPointerIntent)
      window.removeEventListener('pointercancel', clearPointerIntent)
      window.removeEventListener('keydown', markKeyboardIntent)
    }
  }, [sessionId, hasMessageList])

  // 新消息到来 / 进入思考态时，仅在用户仍停留于底部时继续跟随。
  useEffect(() => {
    if (!endRef.current) return
    const isFirst = didInitScrollRef.current !== sessionId
    if (isFirst) {
      // 首次：占位标记先打上，避免这 700ms 内的重渲染又走进首次分支；
      // 等展开动画 + 布局稳定后再瞬时定位到底。
      didInitScrollRef.current = sessionId
      const timer = setTimeout(() => {
        if (shouldFollowRef.current) {
          endRef.current?.scrollIntoView({ behavior: 'auto' })
        }
      }, INIT_SCROLL_DELAY)
      // 清理：会话在延时内被切走 / 组件卸载，撤掉这次滚动，免得滚错会话
      return () => clearTimeout(timer)
    }
    if (!shouldFollowRef.current) return
    // 流式分片频繁到达，使用即时贴底；平滑滚动的中间帧会被误判成用户离开底部。
    endRef.current.scrollIntoView({ behavior: 'auto' })
  }, [sessionId, messages.length, liveReasoningTextLength, isStreaming])

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className={styles.empty}>
        <MessageSquare size={20} className={styles.emptyIcon} />
        <p className={styles.emptyTitle}>还没有对话</p>
        <p className={styles.emptyHint}>在下方输入需求，开始生成第一个版本</p>
      </div>
    )
  }

  // 本轮耗时从最新用户消息开始，截止到最后一张回复、工具或版本卡。版本命名、
  // 构建与截图都属于完整生成链路，因此不能只拿最后一条文本消息作为终点。
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }
  const roundCompleted = lastUserIndex >= 0 && messages.length > lastUserIndex + 1
  const roundDurationMs = roundCompleted
    ? Math.max(
        0,
        messages[messages.length - 1].createdAt - messages[lastUserIndex].createdAt,
      )
    : 0

  // 是否有可重试的内容：至少有一条用户消息（手动编辑只追加版本卡、不产生用户消息）。
  const hasUserMessage = messages.some((m) => m.role === 'user')
  const canRetry = !isStreaming && !!onRetry && hasUserMessage

  // 对话末尾是不是一张「运行中」的工具卡（kind=tool 且还没拿到结果）。
  // 是的话，那张卡自带 loading 转圈，底部就不必再显示「正在生成」，避免双 loading。
  const tail = messages[messages.length - 1]
  const tailToolRunning = tail?.kind === 'tool' && !tail.toolResult

  // 底部生成态文案：把「整轮还在跑」拆成更具体的阶段。
  // 尤其是 check_build 已经成功返回时，右侧预览可能已经能看了，此时继续显示
  // 「模型正在思考」会让用户误以为构建还卡着；改成「预览已生成」更符合实际。
  let thinkingLabel = '正在生成'
  let thinkingHint = `模型正在思考，已等待 ${genSeconds}s…`
  if (latestTool?.toolName === 'check_build' && latestToolResult) {
    if (latestToolResult.includes('构建通过')) {
      thinkingLabel = '预览已生成'
      thinkingHint = `模型正在整理完成说明，已等待 ${genSeconds}s…`
    } else if (latestToolResult.includes('运行时报错') || latestToolResult.includes('构建失败')) {
      thinkingLabel = '收到构建反馈'
      thinkingHint = `模型正在定位并修复问题，已等待 ${genSeconds}s…`
    } else if (latestToolResult.includes('构建超时')) {
      thinkingLabel = '预览等待超时'
      thinkingHint = `模型正在处理超时结果，已等待 ${genSeconds}s…`
    }
  } else if (latestTool?.toolName === 'ask_user' && latestToolResult) {
    thinkingLabel = '正在处理回答'
    thinkingHint = `模型已收到你的回答，正在继续生成，已等待 ${genSeconds}s…`
  } else if (latestTool?.toolResult) {
    thinkingLabel = '继续处理'
    thinkingHint = `模型正在规划下一步，已等待 ${genSeconds}s…`
  }

  return (
    <div ref={listRef} className={styles.list}>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onAskUserAnswer={onAskUserAnswer}
        />
      ))}

      {/* 生成中：不再逐字显示打字，改成带扫光动画的「正在生成」。
          但当对话末尾正好是一张运行中的工具卡（自带 loading 转圈）时就不再显示，
          免得底部又冒一个 loading、和工具卡的转圈重复。空窗期 / 纯对话轮仍然显示。
          若久久没出字（推理型模型思考中、中转又不回传思维链），补一句耐心提示 + 计时，
          让「秒数在走」证明它还在干活，避免被当成卡死。 */}
      {isStreaming && !tailToolRunning && !hasLiveReasoning && (
        <div className={styles.thinkingWrap} aria-live="polite">
          <span className={styles.thinking}>{thinkingLabel}</span>
          {genSeconds >= SLOW_GEN_HINT_AFTER && (
            <span className={styles.thinkingHint}>
              {thinkingHint}
            </span>
          )}
        </div>
      )}

      {/* 本轮总耗时和重新生成是同一个会话级底栏，始终位于完整时间线最下面。 */}
      {!isStreaming && roundCompleted && (
        <div className={styles.timelineMeta}>
          <span
            className={styles.duration}
            title="从本轮需求发出到最后一项结果完成"
          >
            耗时 {formatDuration(roundDurationMs)}
          </span>
          {canRetry && (
            <button
              type="button"
              className={styles.retryBtn}
              onClick={onRetry}
              title="用当前项目状态重新生成这一轮（会追加一个新版本）"
            >
              <RotateCcw size={13} className={styles.retryIcon} />
              <span>重新生成</span>
            </button>
          )}
        </div>
      )}

      <div ref={endRef} className={styles.listEnd} aria-hidden />
    </div>
  )
}
