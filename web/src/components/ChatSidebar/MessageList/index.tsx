import { useEffect, useRef, useState } from 'react'
import { MessageSquare, RotateCcw, PlayCircle } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { formatClock } from '@/lib/format'
import type { Message } from '@/types/project'
import MessageBubble from '../MessageBubble'
import styles from './index.module.scss'

// 首次进入会话时，等右侧预览区的 fade-up 展开动画（0.6s）放完、布局稳定后再滚到底。
// 否则在动画/布局还没稳的时候滚，会滚不到最底。留一点余量取 700ms。
const INIT_SCROLL_DELAY = 700

// 「正在生成」等了这么多秒还没出内容，就补一句耐心提示 + 亮出计时。
// 部分模型（如推理型 Gemini）会先思考几十秒才吐第一个字，且中转不回传思维链 ——
// 期间界面只有 shimmer 容易被当成卡死，这里用「秒数在走」证明它还在干活。
const SLOW_GEN_HINT_AFTER = 6

type Props = {
  /** 重试最新一轮的回调（由 ChatSidebar 提供，内部走流式重生成） */
  onRetry?: () => void
  /** 「继续生成」回调：从断点续跑被中断的那一轮（由 ChatSidebar 提供） */
  onResume?: () => void
  /** ask_user 交互卡片答完的回调（由 ChatSidebar 提供），原样透传给每条消息 */
  onAskUserAnswer?: (message: Message, answer: string) => Promise<void>
}

// ============================================
// 对话列表：渲染当前会话消息 + 流式输出中的 AI 消息
// ============================================
export default function MessageList({ onRetry, onResume, onAskUserAnswer }: Props) {
  const session = useSessionStore((s) => s.activeSession())
  const endRef = useRef<HTMLDivElement>(null)
  // 记录已经为哪个会话做过「首次定位到底部」。首次（刷新 / 切会话）延时滚，
  // 避开预览区展开动画 + 布局抖动；之后的新消息才即时 smooth 平滑滚动。
  const didInitScrollRef = useRef<string | null>(null)

  const messages = session?.messages ?? []
  const isStreaming = session?.isStreaming ?? false
  const awaitingAnswer = session?.awaitingAnswer ?? false
  // 最新一轮被中断、可从断点续跑：据此在对话流末尾显示「继续生成」按钮
  const resumable = session?.resumable ?? false
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

  // 新消息到来 / 进入思考态时滚动到底部
  useEffect(() => {
    if (!endRef.current) return
    const isFirst = didInitScrollRef.current !== sessionId
    if (isFirst) {
      // 首次：占位标记先打上，避免这 700ms 内的重渲染又走进首次分支；
      // 等展开动画 + 布局稳定后再瞬时定位到底。
      didInitScrollRef.current = sessionId
      const timer = setTimeout(() => {
        endRef.current?.scrollIntoView({ behavior: 'auto' })
      }, INIT_SCROLL_DELAY)
      // 清理：会话在延时内被切走 / 组件卸载，撤掉这次滚动，免得滚错会话
      return () => clearTimeout(timer)
    }
    // 同会话后续更新：即时平滑滚动
    endRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [sessionId, messages.length, liveReasoningTextLength, isStreaming, resumable])

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className={styles.empty}>
        <MessageSquare size={20} className={styles.emptyIcon} />
        <p className={styles.emptyTitle}>还没有对话</p>
        <p className={styles.emptyHint}>在下方输入需求，开始生成第一个版本</p>
      </div>
    )
  }

  // 底部操作栏使用最后一条文本消息的时间。跳过工具卡 / 版本卡，因为它们只是
  // 同一轮回复的过程节点，不应该把时间锚点改成工具执行时刻。
  let lastTextIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const k = messages[i].kind
    if (!k || k === 'text') {
      lastTextIndex = i
      break
    }
  }

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
    <div className={styles.list}>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onAskUserAnswer={onAskUserAnswer}
        />
      ))}

      {/* 中断续跑提示卡：最新一轮被打断（刷新 / 锁屏 / 断网）后显示。点「继续生成」从
          断点接着跑，不用从头重来。仅在没有进行中的流 / 没在等 ask_user 回答时出现。 */}
      {resumable && !isStreaming && !awaitingAnswer && onResume && (
        <div className={styles.resumeCard}>
          <p className={styles.resumeText}>上一次生成被中断了，可从断点继续。</p>
          <button
            type="button"
            className={styles.resumeBtn}
            onClick={onResume}
            title="从上次中断的地方继续生成，不用从头重来"
          >
            <PlayCircle size={14} className={styles.resumeIcon} />
            <span>继续生成</span>
          </button>
        </div>
      )}

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

      {/* 时间和重新生成是同一个会话级底栏，始终位于完整时间线最下面。 */}
      {!isStreaming && lastTextIndex >= 0 && (
        <div className={styles.timelineMeta}>
          <time
            className={styles.time}
            dateTime={new Date(messages[lastTextIndex].createdAt).toISOString()}
          >
            {formatClock(messages[lastTextIndex].createdAt)}
          </time>
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
