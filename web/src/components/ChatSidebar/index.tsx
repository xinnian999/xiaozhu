import { useRef, useState } from 'react'
import { ArrowUp, Square, Mic, Paperclip, Image as ImageIcon, X } from 'lucide-react'
import { useSessionStore, makeMessage, makeVersionCard } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { streamChat } from '@/lib/api'
import { toast } from '@/lib/toast'
import MessageList from './MessageList'
import ModelSelector from './ModelSelector'
import styles from './index.module.scss'

// ============================================
// 左侧聊天侧栏
// ============================================
export default function ChatSidebar() {
  const session = useSessionStore((s) => s.activeSession())
  const activeId = useSessionStore((s) => s.activeId)
  const createNew = useSessionStore((s) => s.createNew)
  const appendMessage = useSessionStore((s) => s.appendMessage)
  const setStreamingText = useSessionStore((s) => s.setStreamingText)
  const beginStreaming = useSessionStore((s) => s.beginStreaming)
  const commitStreaming = useSessionStore((s) => s.commitStreaming)
  const endStreaming = useSessionStore((s) => s.endStreaming)
  const applyFileWrite = useSessionStore((s) => s.applyFileWrite)
  const applyFileDelete = useSessionStore((s) => s.applyFileDelete)
  const selectedModel = useSessionStore((s) => s.selectedModel)
  const mobileChatOpen = useUIStore((s) => s.mobileChatOpen)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)
  // 本轮如果改了文件，结束时强制刷一下预览
  // 原因：vite HMR 对 index.html 改动不响应，React Fast Refresh 也偶尔失败
  const reloadPreview = useUIStore((s) => s.reloadPreview)

  const [draft, setDraft] = useState('')
  // 首条消息自动建会话期间禁用输入，避免重复点
  const [creating, setCreating] = useState(false)
  // 本轮流式的中断控制器：点"停止"时 abort()，streamChat 内部据此静默收尾
  const abortRef = useRef<AbortController | null>(null)

  const isStreaming = session?.isStreaming ?? false
  // 无激活会话时，侧栏切换到"全屏空态"布局
  const noSession = activeId === null

  const handleSend = async () => {
    if (!draft.trim() || isStreaming || creating) return

    const text = draft.trim()
    setDraft('')

    // 无激活会话：用首条消息的前缀当标题，先建一个会话再发
    let targetSessionId = session?.id
    if (!targetSessionId) {
      setCreating(true)
      try {
        const newSession = await createNew(text.slice(0, 20))
        targetSessionId = newSession.id
      } catch {
        setCreating(false)
        return
      }
      setCreating(false)
    }

    // 1. 把用户消息追加到列表
    appendMessage(makeMessage('user', text))

    // 2. 立刻进入流式态（不等首个 token）：发送键即时变"停止"，并建好中断控制器
    beginStreaming()
    const controller = new AbortController()
    abortRef.current = controller

    // 本轮是否有文件改动 —— 用来决定结束时要不要刷新预览
    let filesChanged = false

    // 3. 流式消费 SSE，逐 token 累积到 streamingText
    let accumulated = ''
    try {
      for await (const event of streamChat(text, targetSessionId, selectedModel, controller.signal)) {
        if (event.type === 'message_delta') {
          accumulated += event.text
          setStreamingText(accumulated)
        } else if (event.type === 'tool_call') {
          // 工具调用前，先把本轮已累积的叙述（模型在调工具前说的话，
          // 如「好的，我先看看结构」）固化成一条独立气泡，再插工具卡。
          // 这样每一轮的话会和工具进度卡自然交错排列，而不是糊成一坨。
          if (accumulated) {
            commitStreaming()
            accumulated = ''
          }
          // 工具调用 → 在对话流里插一条"进度卡"消息，让用户看到 AI 正在做什么
          // 不入库（后端也不存），刷新会消失，符合"过程信息"语义
          appendMessage(makeMessage('assistant', '', {
            kind: 'tool',
            toolName: event.name,
            toolArgs: event.args as Record<string, unknown>,
          }))
        } else if (event.type === 'file_write') {
          // LLM 写文件 —— 更新本地 files 快照，PreviewPane 会自动 syncFiles
          applyFileWrite(event.path, event.content)
          filesChanged = true
        } else if (event.type === 'file_delete') {
          applyFileDelete(event.path)
          filesChanged = true
        } else if (event.type === 'version') {
          // 产生了新版本：先把本轮已累积的叙述固化成消息（让最终回复气泡先落位），
          // 再插一张版本卡，保证卡片排在回复之后
          if (accumulated) {
            commitStreaming()
            accumulated = ''
          }
          appendMessage(makeVersionCard(event.version_id, event.seq))
        } else if (event.type === 'error') {
          toast(`AI 错误：${event.message}`)
          break
        } else if (event.type === 'done') {
          break
        }
      }
    } finally {
      // 4. 无论正常结束 / 出错 / 用户中断，都冲刷累积内容并退出流式态
      abortRef.current = null
      endStreaming()
      // 5. 文件有变化 → 流结束后强制刷一次预览。
      //    300ms 延迟是为了等最后一次 file_write 触发的 syncFiles 落盘，
      //    否则刷新可能赶在 wc.fs.writeFile 之前，看到的还是旧版。
      if (filesChanged) {
        setTimeout(reloadPreview, 300)
      }
    }
  }

  // 点"停止"：中断本轮 SSE。abort 后 streamChat 抛出被静默吞掉，
  // 控制流自然走到 handleSend 的 finally，由 endStreaming 收尾。
  const handleStop = () => {
    abortRef.current?.abort()
  }

  const composerDisabled = isStreaming || creating
  const placeholder = creating
    ? '正在创建会话…'
    : isStreaming
      ? 'AI 正在回复…'
      : noSession
        ? '描述你想要的应用，我来为你生成…'
        : '继续聊聊还想加点什么…'

  return (
    <>
      {mobileChatOpen && (
        <div
          className={styles.scrim}
          onClick={() => setMobileChatOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`${styles.sidebar} ${mobileChatOpen ? styles.mobileOpen : ''} ${chatCollapsed ? styles.collapsed : ''} ${noSession ? styles.fullscreen : ''}`}
        aria-label="对话"
      >
        <button
          className={styles.mobileClose}
          onClick={() => setMobileChatOpen(false)}
          aria-label="关闭侧栏"
        >
          <X size={16} />
        </button>

        <div className={styles.chatBody}>
          {noSession ? <EmptyHero /> : <MessageList />}
        </div>

        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            <textarea
              className={styles.input}
              placeholder={placeholder}
              value={draft}
              disabled={composerDisabled}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // e.nativeEvent.isComposing：输入法（拼音 / 日文等）正在拼字时为 true。
                // 此时的回车是「确认候选字」，不能当成发送，否则中文用户选字就误发了。
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
            />

            <div className={styles.composerActions}>
              <div className={styles.composerTools}>
                <ModelSelector />
                <button className={styles.toolBtn} aria-label="附件">
                  <Paperclip size={14} />
                </button>
                <button className={styles.toolBtn} aria-label="图片">
                  <ImageIcon size={14} />
                </button>
                <button className={styles.toolBtn} aria-label="语音">
                  <Mic size={14} />
                </button>
              </div>

              {isStreaming ? (
                // 流式进行中：发送键变成"停止"，点击中断本轮生成
                <button
                  className={`${styles.sendBtn} ${styles.stopBtn}`}
                  onClick={handleStop}
                  aria-label="停止生成"
                >
                  <Square size={12} />
                </button>
              ) : (
                <button
                  className={`${styles.sendBtn} ${draft.trim() && !composerDisabled ? styles.sendActive : ''}`}
                  onClick={handleSend}
                  disabled={composerDisabled}
                  aria-label="发送"
                >
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
          </div>

          <div className={styles.composerHint}>
            <span>Shift + Enter 换行</span>
          </div>
        </footer>
      </aside>
    </>
  )
}

// ============================================
// 空态欢迎区：没有激活会话时的引导文案
// ============================================
function EmptyHero() {
  return (
    <div className={styles.hero}>
      <h1 className={styles.heroTitle}>开始构建你的应用</h1>
      <p className={styles.heroSubtitle}>
        在下方输入一句话需求，我会立刻为你生成一个可运行的前端项目
      </p>
    </div>
  )
}
