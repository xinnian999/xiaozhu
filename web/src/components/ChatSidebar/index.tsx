import { useCallback, useRef, useState } from 'react'
import { ArrowUp, Square, Mic, Image as ImageIcon, X, Plus } from 'lucide-react'
import { useSessionStore, makeMessage, makeVersionCard, makeErrorCard } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { streamChat, type SSEEvent } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useClickOutside } from '@/hooks/useClickOutside'
import MessageList from './MessageList'
import ModelSelector from './ModelSelector'
import styles from './index.module.scss'

// 一条消息最多带几张图，和后端 MAX_IMAGES_PER_MESSAGE 对齐
const MAX_IMAGES = 6
// 单张图大小上限（5MB）。data URL 是 base64，会比原图大 ~33%，太大既费 token 又可能超请求体限制
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 把本地图片文件读成 data URL（"data:image/png;base64,..."），失败则 reject。 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

// ============================================
// 左侧聊天侧栏
// ============================================
export default function ChatSidebar() {
  const session = useSessionStore((s) => s.activeSession())
  const activeId = useSessionStore((s) => s.activeId)
  const createNew = useSessionStore((s) => s.createNew)
  const appendMessage = useSessionStore((s) => s.appendMessage)
  const truncateAfterLastUserMessage = useSessionStore((s) => s.truncateAfterLastUserMessage)
  const setToolResult = useSessionStore((s) => s.setToolResult)
  const upsertToolCall = useSessionStore((s) => s.upsertToolCall)
  const setStreamingText = useSessionStore((s) => s.setStreamingText)
  const beginStreaming = useSessionStore((s) => s.beginStreaming)
  const commitStreaming = useSessionStore((s) => s.commitStreaming)
  const endStreaming = useSessionStore((s) => s.endStreaming)
  const applyFileWrite = useSessionStore((s) => s.applyFileWrite)
  const applyFileDelete = useSessionStore((s) => s.applyFileDelete)
  const selectedModel = useSessionStore((s) => s.selectedModel)
  const models = useSessionStore((s) => s.models)
  const mobileChatOpen = useUIStore((s) => s.mobileChatOpen)
  const setMobileChatOpen = useUIStore((s) => s.setMobileChatOpen)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)
  // 把暂存的文件揭晓到预览并触发重新构建（AI 调 check_build 时触发）
  const requestPreviewApply = useUIStore((s) => s.requestPreviewApply)
  // 点缩略图放大预览
  const openImagePreview = useUIStore((s) => s.openImagePreview)

  const [draft, setDraft] = useState('')
  // 首条消息自动建会话期间禁用输入，避免重复点
  const [creating, setCreating] = useState(false)
  // 本轮流式的中断控制器：点"停止"时 abort()，streamChat 内部据此静默收尾
  const abortRef = useRef<AbortController | null>(null)

  // 待发送的图片（data URL 列表）。发送后清空；点缩略图上的 × 可逐个移除。
  const [attachments, setAttachments] = useState<string[]>([])
  // 隐藏的 <input type=file>：点「添加图片」时用 ref 触发它的原生文件选择框
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 输入框工具栏的「加号」展开态：图片 / 语音等次要输入方式收进这个菜单里。
  // 点菜单外的任意处自动收起（复用和 ModelSelector 同一套 useClickOutside）。
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)
  const closeTools = useCallback(() => setToolsOpen(false), [])
  useClickOutside(toolsRef, closeTools)

  const isStreaming = session?.isStreaming ?? false
  // 无激活会话时，侧栏切换到"全屏空态"布局
  const noSession = activeId === null

  // 当前选中模型是否支持识图（多模态）。由后端实测标定的 vision 字段决定。
  // 不支持时把「添加图片」置灰：清单还没加载好（找不到当前模型）也按不支持处理，
  // 避免在不确定时放开传图。
  const visionSupported = models.find((m) => m.id === selectedModel)?.vision ?? false

  // 点「添加图片」：触发隐藏 file input 的原生选择框
  const openImagePicker = () => {
    setToolsOpen(false)
    fileInputRef.current?.click()
  }

  // 把一组图片文件读成 data URL 追加到 attachments —— 文件选择和粘贴共用。
  // 做张数 / 大小 / 类型校验：非图片跳过，超 5MB 跳过，超张数上限的多余部分丢弃。
  const addImageFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return

    const remaining = MAX_IMAGES - attachments.length
    if (remaining <= 0) {
      toast(`最多只能添加 ${MAX_IMAGES} 张图片`)
      return
    }

    const picked: string[] = []
    for (const file of images.slice(0, remaining)) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast('单张图片超过 5MB，已跳过')
        continue
      }
      try {
        picked.push(await fileToDataUrl(file))
      } catch {
        toast('图片读取失败')
      }
    }
    if (images.length > remaining) toast(`一次最多 ${MAX_IMAGES} 张，多余的已忽略`)
    if (picked.length) setAttachments((prev) => [...prev, ...picked])
  }

  // 点「添加图片」选好文件后
  const onFilesPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // 清空，使「再选同一张」也能触发 onChange
    await addImageFiles(files)
  }

  // 往输入框粘贴：剪贴板里有图片（截图 / 复制的图）就当附件加入。
  // 模型不支持识图时给出提示而不静默吞掉 —— 否则用户粘了没反应会一头雾水。
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return // 没有图片，走默认的文本粘贴

    e.preventDefault() // 有图片：拦下默认行为，按附件处理
    if (!visionSupported) {
      toast('当前模型不支持识图，请切换到支持识图的模型')
      return
    }
    await addImageFiles(images)
  }

  // 移除某张待发图片
  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  // 消费一条 SSE 流：把后端事件逐条映射到 store。发送 / 重试共用同一套处理逻辑，
  // 避免两份几乎一样的事件分发代码各写一遍、日后改协议还得改两处。
  const consumeStream = async (stream: AsyncGenerator<SSEEvent>) => {
    // 逐 token 累积到本地变量，再统一冲刷给 store
    let accumulated = ''
    for await (const event of stream) {
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
        // 工具调用 → 在对话流里插一条"进度卡"消息，让用户看到 AI 正在做什么。
        // 用 upsertToolCall 按 toolCallId 幂等处理：后端会发两次同 id 的 tool_call ——
        // 流式阶段先发一张只带 path 的（卡片秒出），整段参数生成完后再发一张带完整参数的
        //（含 write_file 的 content）。第一次新建卡、第二次补全同一张卡，展开就能看到全部参数。
        // 后端也会把工具消息入库（含完整参数 + 结果），刷新后由 fromApiMessage 还原。
        upsertToolCall(event.id, event.name, event.args as Record<string, unknown>)
      } else if (event.type === 'tool_result') {
        // 工具执行完 → 按 id 找到对应工具卡，把结果填上（卡片展开即可查看）
        setToolResult(event.id, event.result)
      } else if (event.type === 'file_write') {
        // LLM 写文件 —— 只更新本地 files 快照（代码视图/文件树实时跟着变）。
        // 注意：流式途中 PreviewPane 不会自动构建，运行中的预览保持上一个稳定态，
        // 等收到 preview_refresh 才揭晓 + 重新构建，避免闪半成品、也省掉多次全量构建。
        applyFileWrite(event.path, event.content)
      } else if (event.type === 'file_delete') {
        applyFileDelete(event.path)
      } else if (event.type === 'preview_refresh') {
        // AI 调 check_build：这一组改动写完、可渲染了 —— 把暂存文件应用进预览并重新构建
        requestPreviewApply()
      } else if (event.type === 'version') {
        // 产生了新版本：先把本轮已累积的叙述固化成消息（让最终回复气泡先落位），
        // 再插一张版本卡，保证卡片排在回复之后
        if (accumulated) {
          commitStreaming()
          accumulated = ''
        }
        appendMessage(makeVersionCard(event.version_id, event.seq))
      } else if (event.type === 'error') {
        // 先把本轮已累积的叙述固化成气泡（别丢了 AI 报错前说的话），
        // 再在对话流里就地插一张错误卡 —— 比一闪而过的 toast 更醒目、可回看。
        if (accumulated) {
          commitStreaming()
          accumulated = ''
        }
        appendMessage(makeErrorCard(event.message))
        break
      } else if (event.type === 'done') {
        break
      }
    }
  }

  const handleSend = async () => {
    // 有文字或有图都可发；流式中 / 建会话中不可发
    if ((!draft.trim() && attachments.length === 0) || isStreaming || creating) return

    // 带了图但当前模型不支持识图：拦下来并提示（防止用户加图后又切了非识图模型）
    if (attachments.length > 0 && !visionSupported) {
      toast('当前模型不支持识图，请切换到支持识图的模型，或移除图片')
      return
    }

    const text = draft.trim()
    const images = attachments
    setDraft('')
    setAttachments([])

    // 无激活会话：用首条消息的前缀当标题，先建一个会话再发
    // 只发图片没文字时，text 为空，用「图片对话」兜底当标题
    let targetSessionId = session?.id
    if (!targetSessionId) {
      setCreating(true)
      try {
        const newSession = await createNew(text.slice(0, 20) || '图片对话')
        targetSessionId = newSession.id
      } catch {
        setCreating(false)
        return
      }
      setCreating(false)
    }

    // 1. 把用户消息（连同图片缩略图）追加到列表
    appendMessage(makeMessage('user', text, images.length ? { images } : undefined))

    // 2. 立刻进入流式态（不等首个 token）：发送键即时变"停止"，并建好中断控制器
    beginStreaming()
    const controller = new AbortController()
    abortRef.current = controller

    // 3. 流式消费 SSE
    try {
      await consumeStream(streamChat(text, targetSessionId, selectedModel, controller.signal, images))
    } finally {
      // 4. 无论正常结束 / 出错 / 用户中断，都冲刷累积内容并退出流式态。
      //    退出流式态会让 PreviewPane 的构建 effect 重跑：若本轮有改动还没构建过
      //    （AI 没在最后调 check_build），它会兜底构建最终态 + 刷新预览，所以这里
      //    不必再手动刷——手动刷只会重载到旧 dist（没重新构建），没有意义。
      abortRef.current = null
      endStreaming()
    }
  }

  // 重试最新一轮：用「当前项目状态」重新跑最后一条用户消息，结尾追加一个新版本
  // （比如最后一轮生成的是 v3，期间手动改到了 v7，重试就在 v7 之上生成 v8，不动 v3）。
  // 不新增用户气泡 —— prompt 由后端复用最后一条用户消息，旧回复 / 旧版本都保留。
  const handleRetry = async () => {
    if (!session || isStreaming || creating) return

    // 先把最新一轮用户消息之后的旧内容从对话里截掉 —— 看起来像把这条消息重新发出去。
    // 后端会同步删掉这些消息行（但保留版本快照），两边对「最后一条用户消息」的判定一致。
    truncateAfterLastUserMessage()

    // 进入流式态 + 建中断控制器，和发送完全一致，所以「停止」按钮一样能中断重试
    beginStreaming()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      // message 传空串、retry=true：真正的 prompt 由后端取最后一条用户消息
      await consumeStream(streamChat('', session.id, selectedModel, controller.signal, [], true))
    } finally {
      abortRef.current = null
      endStreaming()
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
          {noSession ? <EmptyHero /> : <MessageList onRetry={handleRetry} />}
        </div>

        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            {/* 隐藏的文件选择框：由「添加图片」按钮触发。accept 限图片、multiple 允许多选 */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onFilesPicked}
            />

            {/* 待发送图片缩略图行：每张右上角带 × 可移除 */}
            {attachments.length > 0 && (
              <div className={styles.attachments}>
                {attachments.map((src, i) => (
                  <div key={i} className={styles.thumb}>
                    <img
                      src={src}
                      className={styles.thumbImg}
                      alt={`待发送图片 ${i + 1}`}
                      onClick={() => openImagePreview(src)}
                    />
                    <button
                      type="button"
                      className={styles.thumbRemove}
                      onClick={() => removeAttachment(i)}
                      aria-label="移除图片"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              className={styles.input}
              placeholder={placeholder}
              value={draft}
              disabled={composerDisabled}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={handlePaste}
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

                {/* 把「图片 / 语音」这些次要输入方式收进一个加号里，点击向上展开。
                    移动端工具栏窄，多个图标平铺既挤又难点中；收成一个加号，
                    点击区更大、视觉更干净，手机上交互顺手很多。 */}
                <div className={styles.moreTools} ref={toolsRef}>
                  <button
                    type="button"
                    className={`${styles.toolBtn} ${toolsOpen ? styles.toolBtnOpen : ''}`}
                    onClick={() => setToolsOpen((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={toolsOpen}
                    aria-label="更多输入方式"
                  >
                    <Plus size={16} className={styles.plusIcon} />
                  </button>

                  {toolsOpen && (
                    <div className={styles.morePanel} role="menu" aria-label="更多输入方式">
                      {/* 添加图片：仅当前模型支持识图时可用，否则置灰并提示换模型。
                          disabled 同时挡住点击，className 加 disabled 态走灰色样式。 */}
                      <button
                        type="button"
                        role="menuitem"
                        className={`${styles.moreItem} ${visionSupported ? '' : styles.moreItemDisabled}`}
                        disabled={!visionSupported}
                        title={visionSupported ? undefined : '当前模型不支持识图，请切换到支持识图的模型'}
                        onClick={openImagePicker}
                      >
                        <ImageIcon size={16} className={styles.moreItemIcon} />
                        <span className={styles.moreItemLabel}>添加图片</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.moreItem}
                        onClick={() => {
                          setToolsOpen(false)
                          toast('语音输入开发中，敬请期待')
                        }}
                      >
                        <Mic size={16} className={styles.moreItemIcon} />
                        <span className={styles.moreItemLabel}>语音输入</span>
                      </button>
                    </div>
                  )}
                </div>

                <ModelSelector />
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
                  className={`${styles.sendBtn} ${(draft.trim() || attachments.length > 0) && !composerDisabled ? styles.sendActive : ''}`}
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
