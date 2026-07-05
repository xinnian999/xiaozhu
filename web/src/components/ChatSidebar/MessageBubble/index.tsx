import { useState } from 'react'
import { FileText, FilePlus, FilePen, FolderOpen, Wrench, Bug, ChevronRight, GitCommit, RotateCcw, Loader2, Check, AlertCircle, HelpCircle } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatClock } from '@/lib/format'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { toast } from '@/lib/toast'
import type { Message } from '@/types/project'
import styles from './index.module.scss'

type Props = {
  message: Message
  /** 是否正在流式输出（显示光标动画，隐藏时间戳） */
  isStreaming?: boolean
  /** 是否是对话里最后一条文本消息 —— 只有它才显示时间，作为本轮结束的标记 */
  isLast?: boolean
  /** 重试回调。仅传给「最终回复」那条 AI 文本消息 —— 传了就在时间同行右侧渲染「重新生成」，
   *  这样按钮落在版本卡之前（最终回复在 DOM 上排在版本卡前面），而不是堆到所有版本卡下方。 */
  onRetry?: () => void
  /** ask_user 交互卡片答完（单个问题或多问题 Tab 全部答完）时的回调，只传给 kind='tool'
   *  且 toolName='ask_user' 的消息。answer 是 AskUserChip 内部已经汇总格式化好的文本。 */
  onAskUserAnswer?: (message: Message, answer: string) => Promise<void>
}

// ============================================
// 单条对话气泡
// ============================================
// - kind === 'tool'：渲染成"工具调用进度卡"，紧凑显示工具名 + 关键参数
//   （toolName === 'ask_user' 走独立的 AskUserChip，其余走 ToolCallChip）
// - kind === 'version'：渲染成"版本卡"，附带回滚按钮
// - 其余情况：渲染成普通文本气泡
export default function MessageBubble({ message, isStreaming = false, isLast = false, onRetry, onAskUserAnswer }: Props) {
  // 必须在任何条件 return 之前调用 hook（Hooks 规则）
  const openImagePreview = useUIStore((s) => s.openImagePreview)

  if (message.kind === 'tool') {
    if (message.toolName === 'ask_user') {
      return <AskUserChip message={message} onAnswer={onAskUserAnswer} />
    }
    return <ToolCallChip message={message} />
  }
  if (message.kind === 'version') {
    return <VersionCard message={message} />
  }
  if (message.kind === 'error') {
    return <ErrorCard message={message} />
  }

  const isUser = message.role === 'user'

  // AI 消息：不要头像和气泡，直接把正文渲染成 markdown
  if (!isUser) {
    return (
      <div className={styles.assistantMsg}>
        <div className={styles.markdown}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // 链接在新标签打开，避免点了把整个应用导航走
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {message.text}
          </Markdown>
          {/* 流式输出时在末尾追加闪烁光标 */}
          {isStreaming && <span className={styles.cursor} aria-hidden />}
        </div>

        {!isStreaming && isLast && (
          // 时间 + 「重新生成」同一行：时间在左，按钮在右（onRetry 传了才显示）。
          <div className={styles.metaRow}>
            <time className={styles.time} dateTime={new Date(message.createdAt).toISOString()}>
              {formatClock(message.createdAt)}
            </time>
            {onRetry && (
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
      </div>
    )
  }

  // 用户消息：保留右侧气泡
  return (
    <article className={`${styles.bubble} ${styles.user}`}>
      <div className={styles.content}>
        {/* 用户发的图片：缩略图网格，排在文字上方 */}
        {message.images && message.images.length > 0 && (
          <div className={styles.images}>
            {message.images.map((src, i) => (
              <img
                key={i}
                src={src}
                className={styles.image}
                alt={`图片 ${i + 1}`}
                onClick={() => openImagePreview(src)}
              />
            ))}
          </div>
        )}

        {/* 只发图片没文字时不渲染空段落 */}
        {message.text && <p className={styles.text}>{message.text}</p>}

        {isLast && (
          <time className={styles.time} dateTime={new Date(message.createdAt).toISOString()}>
            {formatClock(message.createdAt)}
          </time>
        )}
      </div>
    </article>
  )
}

// ============================================
// 工具调用进度卡：让用户看到 AI "正在做什么"
// ============================================
// 一行细窄卡片，避免抢眼。有参数或有执行结果就可点击展开，查看参数（如 write_file
// 的文件内容）和工具结果（如 check_build 的报错、read_file 的内容）。
function ToolCallChip({ message }: { message: Message }) {
  const { icon, label } = describeToolCall(message.toolName, message.toolArgs)
  const args = message.toolArgs
  const result = message.toolResult
  const hasArgs = !!args && Object.keys(args).length > 0
  const hasResult = !!result && result.length > 0
  // 「运行中 / 已完成」两态以「有没有工具结果」区分：结果还没回来 = 工具还在跑。
  // 文案不分状态（保持原样），运行 / 完成只靠右侧图标区分即可。
  const running = !hasResult
  // 运行中不让展开（参数还没补全、也没结果可看）；跑完拿到结果后才可展开看参数 + 结果。
  const expandable = hasResult
  const [expanded, setExpanded] = useState(false)

  // 头部内容（图标 + 文案 + 右侧状态图标）两种渲染路径共用。
  // 右侧：运行中是转圈的 loading 动画，完成后变成可点开的箭头。
  const inner = (
    <>
      <span className={styles.toolChipIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.toolChipLabel}>{label}</span>
      {running ? (
        <Loader2 size={12} className={styles.toolChipSpinner} aria-hidden />
      ) : (
        <ChevronRight
          size={12}
          className={`${styles.toolChipChevron} ${expanded ? styles.toolChipChevronOpen : ''}`}
          aria-hidden
        />
      )}
    </>
  )

  return (
    <div className={`${styles.toolChip} ${expandable ? styles.toolChipExpandable : ''}`}>
      {expandable ? (
        <button
          type="button"
          className={styles.toolChipHeader}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {inner}
        </button>
      ) : (
        <div className={styles.toolChipHeader} role="status" aria-label={label}>
          {inner}
        </div>
      )}

      {expanded && (
        <div className={styles.toolChipDetail}>
          {hasArgs && (
            <>
              <span className={styles.toolChipDetailLabel}>参数</span>
              <pre className={styles.toolChipArgs}>{formatArgs(args)}</pre>
            </>
          )}
          {hasResult && (
            <>
              <span className={styles.toolChipDetailLabel}>结果</span>
              <pre className={styles.toolChipArgs}>{result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// AI 主动提问卡：ask_user 工具专用，支持单个问题 / 多问题 Tab 化呈现
// ============================================
// 数据来自通用的 tool_call 事件（message.toolArgs.questions），不是独立的 SSE 事件类型。
// 每个问题各自单选或多选，点「提交/确认」后才切到下一题，全部答完才一次性提交
// （见 onAnswer：内部会 POST /ask-result 唤醒后端，或降级为发一条新消息）。
type AskQuestion = { question: string; options: string[]; multi?: boolean }

function isAskQuestions(v: unknown): v is AskQuestion[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (q) =>
        !!q &&
        typeof q === 'object' &&
        typeof (q as { question?: unknown }).question === 'string' &&
        Array.isArray((q as { options?: unknown }).options),
    )
  )
}

// 把每题的 Q&A 拼成一份结构化文本，作为最终提交的 answer（也是 ToolMessage 回喂给 LLM 的内容）
function combineAskAnswers(questions: AskQuestion[], answers: (string | null)[]): string {
  return questions
    .map((q, i) => `问题${i + 1}：${q.question}\n回答：${answers[i] ?? ''}`)
    .join('\n\n')
}

// 把「已回答」汇总文本按题拆开，用于分题展示；拆不出结构（老数据格式等）时返回 null，
// 调用方退回整段展示，不强行拆错。
function parseDoneAnswer(done: string): { question: string; answer: string }[] | null {
  const items = done.split('\n\n').map((block) => {
    const match = block.match(/^问题\d+：([\s\S]*?)\n回答：([\s\S]*)$/)
    return match ? { question: match[1], answer: match[2] } : null
  })
  return items.every((item): item is { question: string; answer: string } => item !== null)
    ? items
    : null
}

// 「不确定，你决定」按钮提交给后端的固定文案
const ASK_FALLBACK_ANSWER = '不确定，你来决定最合适的方案'
// 多选一题全不勾时的兜底文案
const ASK_MULTI_EMPTY_ANSWER = '暂不需要，先用基础版本'
// 自定义回答的通用选项文案（UI 专用，选中后才展开输入框）
const ASK_CUSTOM_OPTION_LABEL = '说说其他想法'

/** 从已保存的单选答案还原 UI 选中态（切 Tab 回已答题时复用） */
function parseSingleAskAnswer(
  question: AskQuestion,
  answer: string | null,
): { selectedIndex: number | null; isFallback: boolean; customText: string; isCustom: boolean } {
  if (!answer) return { selectedIndex: null, isFallback: false, customText: '', isCustom: false }
  if (answer === ASK_FALLBACK_ANSWER) {
    return { selectedIndex: null, isFallback: true, customText: '', isCustom: false }
  }
  const idx = question.options.findIndex((opt) => opt === answer)
  if (idx !== -1) return { selectedIndex: idx, isFallback: false, customText: '', isCustom: false }
  return { selectedIndex: null, isFallback: false, customText: answer, isCustom: true }
}

/** 从已保存的多选答案还原勾选态与自定义补充（格式见 confirmMulti） */
function parseMultiAskAnswer(
  question: AskQuestion,
  answer: string | null,
): { checked: Set<number>; customText: string; isCustom: boolean } {
  if (!answer || answer === ASK_MULTI_EMPTY_ANSWER) {
    return { checked: new Set(), customText: '', isCustom: false }
  }
  const match = answer.match(/^已选：([\s\S]+?)(?:；补充：([\s\S]+))?$/)
  if (!match) return { checked: new Set(), customText: answer, isCustom: true }
  const checked = new Set<number>()
  for (const label of match[1].split('、')) {
    const idx = question.options.findIndex((opt) => opt === label)
    if (idx !== -1) checked.add(idx)
  }
  const customText = match[2]?.trim() ?? ''
  return { checked, customText, isCustom: customText.length > 0 }
}

// 从 activeIndex 之后开始找下一个未答的题，找不到就从头找一圈；全部答完返回 -1
function findNextUnanswered(answers: (string | null)[], from: number): number {
  for (let step = 1; step <= answers.length; step++) {
    const i = (from + step) % answers.length
    if (answers[i] == null) return i
  }
  return -1
}

function AskUserChip({
  message,
  onAnswer,
}: {
  message: Message
  onAnswer?: (message: Message, answer: string) => Promise<void>
}) {
  const rawQuestions = message.toolArgs?.questions
  const questions = isAskQuestions(rawQuestions) ? rawQuestions : null
  const questionsLen = questions?.length ?? 0

  const [activeIndex, setActiveIndex] = useState(0)
  const [answers, setAnswers] = useState<(string | null)[]>(() =>
    Array.from({ length: questionsLen }, () => null),
  )
  const [busy, setBusy] = useState(false)
  // 提交成功后本地立即记住这份汇总文本，不必等 SSE 的 tool_result 事件回来才展示「已回答」，
  // 避免提交成功到事件抵达之间的短暂空窗又闪回可交互态。
  const [submitted, setSubmitted] = useState<string | null>(null)

  // questions 在流式阶段可能从「还没有」变成「完整数组」，长度变化时才重建 answers
  // （只依赖 length，避免 toolArgs 对象每次新引用都误触发重置，抹掉用户已经填的答案）。
  // 按 React 官方推荐的「渲染期间调整 state」写法，不用 useEffect：
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevQuestionsLen, setPrevQuestionsLen] = useState(questionsLen)
  if (questionsLen !== prevQuestionsLen) {
    setPrevQuestionsLen(questionsLen)
    setAnswers(Array.from({ length: questionsLen }, () => null))
  }

  if (!questions) {
    // 工具名先到、完整参数还在流式路上：先出个占位态，别渲染空的问题/按钮
    return (
      <div className={styles.askChip}>
        <div className={styles.askChipPlaceholder}>
          <HelpCircle size={13} className={styles.askChipIcon} aria-hidden />
          <span>想确认几件事…</span>
        </div>
      </div>
    )
  }

  const done = submitted ?? message.toolResult
  if (done) {
    const parsed = parseDoneAnswer(done)
    return (
      <div className={styles.askChip}>
        <div className={styles.askChipDone}>
          <div className={styles.askChipDoneHeader}>
            <HelpCircle size={13} className={styles.askChipIcon} aria-hidden />
            <span>已回答</span>
          </div>
          {parsed ? (
            <div className={styles.askChipDoneList}>
              {parsed.map((qa, i) => (
                <div className={styles.askChipDoneItem} key={i}>
                  <div className={styles.askChipDoneQ}>
                    {parsed.length > 1 ? `${i + 1}. ${qa.question}` : qa.question}
                  </div>
                  <div className={styles.askChipDoneA}>{qa.answer}</div>
                </div>
              ))}
            </div>
          ) : (
            <span className={styles.askChipDoneText}>{done}</span>
          )}
        </div>
      </div>
    )
  }

  // 某一题点「提交/确认」后：记入本地答案数组，再切到下一个未答的题；全部答完才汇总提交一次。
  const finalizeQuestion = async (index: number, answer: string) => {
    const next = [...answers]
    next[index] = answer
    setAnswers(next)

    const nextUnanswered = findNextUnanswered(next, index)
    if (nextUnanswered !== -1) {
      setActiveIndex(nextUnanswered)
      return
    }

    const combined = combineAskAnswers(questions, next)
    setBusy(true)
    try {
      await onAnswer?.(message, combined)
      setSubmitted(combined)
    } catch (e) {
      // 不清空 answers：失败只是这次汇总提交没成功，允许用户直接再触发一次提交重试
      toast(`提交失败：${e instanceof Error ? e.message : String(e)}，请重试`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.askChip}>
      {questions.length > 1 && (
        <div className={styles.askChipTabs} role="tablist">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === activeIndex}
              disabled={busy}
              title={q.question}
              className={`${styles.askChipTab} ${i === activeIndex ? styles.askChipTabActive : ''}`}
              onClick={() => setActiveIndex(i)}
            >
              {answers[i] != null && <Check size={11} className={styles.askChipTabCheck} aria-hidden />}
              <span className={styles.askChipTabLabel}>问题{i + 1}</span>
            </button>
          ))}
        </div>
      )}

      {questions.map((q, i) => (
        <AskQuestionBody
          // 每题各挂一份面板并常驻 DOM，切 Tab 只切换显隐，避免卸载后丢失勾选/选中态
          key={i}
          hidden={i !== activeIndex}
          question={q}
          initialAnswer={answers[i]}
          disabled={busy}
          onFinalize={(answer) => finalizeQuestion(i, answer)}
        />
      ))}
    </div>
  )
}

// 单个问题的作答区：单选 / 多选都是先本地选好，再点「提交/确认」才记入答案并切下一题；
// 自定义回答通过末尾通用选项「说说其他想法」展开输入框。
function AskQuestionBody({
  question,
  initialAnswer,
  hidden,
  disabled,
  onFinalize,
}: {
  question: AskQuestion
  /** 本题已保存的答案；切 Tab 回来时用来恢复选中/勾选态 */
  initialAnswer?: string | null
  /** 非当前 Tab 的面板：隐藏但保留 DOM，避免切走再切回时丢失本地勾选态 */
  hidden?: boolean
  disabled: boolean
  onFinalize: (answer: string) => void
}) {
  const multi = !!question.multi
  const parsedMulti = parseMultiAskAnswer(question, initialAnswer ?? null)
  const parsedSingle = parseSingleAskAnswer(question, initialAnswer ?? null)
  const [checked, setChecked] = useState<Set<number>>(() => parsedMulti.checked)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() => parsedSingle.selectedIndex)
  const [isFallbackSelected, setIsFallbackSelected] = useState(() => parsedSingle.isFallback)
  const [isCustomSelected, setIsCustomSelected] = useState(() =>
    multi ? parsedMulti.isCustom : parsedSingle.isCustom,
  )
  const [customText, setCustomText] = useState(() =>
    multi ? parsedMulti.customText : parsedSingle.customText,
  )

  const toggleOption = (i: number) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const toggleCustom = () => {
    setIsCustomSelected((prev) => {
      if (prev) setCustomText('')
      return !prev
    })
  }

  const selectCustomSingle = () => {
    setIsCustomSelected(true)
    setSelectedIndex(null)
    setIsFallbackSelected(false)
  }

  // 多选「确认」：把已勾选项拼成「已选：a、b」；一个都没勾就是「暂不需要，先用基础版本」
  // （这就是「不强制选择」的落点）；「说说其他想法」有内容则一并/单独拼进去。
  const confirmMulti = () => {
    const text = customText.trim()
    const picked = question.options.filter((_, i) => checked.has(i))
    if (isCustomSelected && text) {
      if (picked.length === 0) {
        onFinalize(text)
        return
      }
      onFinalize(`已选：${picked.join('、')}；补充：${text}`)
      return
    }
    if (picked.length === 0) {
      onFinalize(ASK_MULTI_EMPTY_ANSWER)
      return
    }
    onFinalize(`已选：${picked.join('、')}`)
  }

  // 单选「提交」：取当前选中的选项、「不确定，你决定」或「说说其他想法」输入
  const submitSingle = () => {
    if (isCustomSelected) {
      const text = customText.trim()
      if (!text) return
      onFinalize(text)
      return
    }
    if (selectedIndex !== null) {
      onFinalize(question.options[selectedIndex])
      return
    }
    if (isFallbackSelected) {
      onFinalize(ASK_FALLBACK_ANSWER)
    }
  }

  const canSubmitSingle =
    (isCustomSelected && !!customText.trim()) ||
    selectedIndex !== null ||
    isFallbackSelected

  // 勾了「说说其他想法」但没填内容、也没选其他项时不可提交
  const canSubmitMulti = checked.size > 0 || !isCustomSelected || !!customText.trim()

  return (
    <div
      className={styles.askChipBody}
      role="tabpanel"
      hidden={hidden}
    >
      <p className={styles.askChipQuestion}>{question.question}</p>

      {multi ? (
        <div className={styles.askChipOptions}>
          {question.options.map((opt, i) => (
            <label
              key={i}
              className={`${styles.askChipCheckbox} ${checked.has(i) ? styles.askChipCheckboxSelected : ''}`}
            >
              <input
                type="checkbox"
                checked={checked.has(i)}
                disabled={disabled}
                onChange={() => toggleOption(i)}
              />
              <span>{opt}</span>
            </label>
          ))}
          <label
            className={`${styles.askChipCheckbox} ${isCustomSelected ? styles.askChipCheckboxSelected : ''}`}
          >
            <input
              type="checkbox"
              checked={isCustomSelected}
              disabled={disabled}
              onChange={toggleCustom}
            />
            <span>{ASK_CUSTOM_OPTION_LABEL}</span>
          </label>
        </div>
      ) : (
        <div className={styles.askChipOptions}>
          {question.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              className={`${styles.askChipOptionBtn} ${selectedIndex === i ? styles.askChipOptionBtnSelected : ''}`}
              disabled={disabled}
              onClick={() => {
                setSelectedIndex(i)
                setIsFallbackSelected(false)
                setIsCustomSelected(false)
              }}
            >
              {opt}
            </button>
          ))}
          <button
            type="button"
            className={`${styles.askChipOptionBtn} ${styles.askChipFallbackBtn} ${isFallbackSelected ? styles.askChipOptionBtnSelected : ''}`}
            disabled={disabled}
            onClick={() => {
              setSelectedIndex(null)
              setIsFallbackSelected(true)
              setIsCustomSelected(false)
            }}
          >
            不确定，你决定
          </button>
          <button
            type="button"
            className={`${styles.askChipOptionBtn} ${isCustomSelected ? styles.askChipOptionBtnSelected : ''}`}
            disabled={disabled}
            onClick={selectCustomSingle}
          >
            {ASK_CUSTOM_OPTION_LABEL}
          </button>
        </div>
      )}

      {isCustomSelected && (
        <input
          type="text"
          className={styles.askChipCustomInput}
          placeholder="说说你的想法…"
          value={customText}
          disabled={disabled}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (multi) {
                if (canSubmitMulti) confirmMulti()
              } else if (canSubmitSingle) {
                submitSingle()
              }
            }
          }}
        />
      )}

      <div className={styles.askChipSubmitRow}>
        {multi ? (
          <button
            type="button"
            className={styles.askChipConfirmBtn}
            disabled={disabled || !canSubmitMulti}
            onClick={confirmMulti}
          >
            确认
          </button>
        ) : (
          <button
            type="button"
            className={styles.askChipConfirmBtn}
            disabled={disabled || !canSubmitSingle}
            onClick={submitSingle}
          >
            提交
          </button>
        )}
      </div>
    </div>
  )
}

// ============================================
// 错误卡：AI 报错时在对话流里就地提示
// ============================================
// 红色描边的一条提示，图标 + 错误说明（后端 error 事件的 message，如「未配置 api_key」）。
// 比 toast 醒目且可回看，让用户一眼知道这轮为什么没结果。
function ErrorCard({ message }: { message: Message }) {
  return (
    <div className={styles.errorCard} role="alert">
      <AlertCircle size={14} className={styles.errorCardIcon} aria-hidden />
      <span className={styles.errorCardText}>{message.text}</span>
    </div>
  )
}

// ============================================
// 版本卡：每产生一个新版本插一张，附带回滚按钮
// ============================================
// 点「回滚」→ 用该版本快照覆盖当前文件，并 append 一个新版本（回滚即新版），
// 因此回滚后又会再插一张新的版本卡。
function VersionCard({ message }: { message: Message }) {
  const rollbackToVersion = useSessionStore((s) => s.rollbackToVersion)
  // 当前会话所有版本卡里最大的 seq —— 它就是「当前（最新）版本」。
  // selector 只返回一个数字（基本类型），引用稳定，不会触发多余重渲染。
  const latestSeq = useSessionStore((s) => {
    const sess = s.activeSession()
    if (!sess) return null
    let max = -1
    for (const m of sess.messages) {
      if (m.kind === 'version' && typeof m.versionSeq === 'number' && m.versionSeq > max) {
        max = m.versionSeq
      }
    }
    return max === -1 ? null : max
  })
  const [busy, setBusy] = useState(false)
  const seq = message.versionSeq
  const versionId = message.versionId
  // 是不是当前版本：回滚到自己没有意义，所以当前版本不提供回滚入口
  const isCurrent = seq != null && latestSeq != null && seq === latestSeq

  const handleRollback = async () => {
    if (busy || versionId == null) return
    setBusy(true)
    try {
      await rollbackToVersion(versionId)
      toast(`已回滚到 v${seq}`)
    } catch (e) {
      toast(`回滚失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.versionCard}>
      <span className={styles.versionCardIcon} aria-hidden>
        <GitCommit size={13} />
      </span>
      <span className={styles.versionCardLabel}>
        已生成版本 <b className={styles.versionCardSeq}>v{seq ?? '?'}</b>
      </span>
      {isCurrent ? (
        // 当前版本：展示「当前」标记，不提供回滚（回滚到自己没意义）
        <span className={styles.versionCardCurrent}>
          <Check size={12} />
          <span>当前</span>
        </span>
      ) : (
        <button
          className={styles.versionCardBtn}
          onClick={handleRollback}
          disabled={busy || versionId == null}
          aria-label={seq != null ? `回滚到 v${seq}` : '回滚'}
          title="回滚到此版本（会生成一个新版本）"
        >
          {busy ? <Loader2 size={12} className={styles.versionSpin} /> : <RotateCcw size={12} />}
          <span>回滚</span>
        </button>
      )}
    </div>
  )
}

// 把工具参数格式化成易读的多行文本。
// 不用 JSON.stringify —— 它会把 write_file 的文件内容里的换行转成字面量 \n，
// 挤成一长串没法看。这里对字符串值保留真实换行，多行值另起一行展示。
function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => {
      const val = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return val.includes('\n') ? `${key}:\n${val}` : `${key}: ${val}`
    })
    .join('\n\n')
}

// 把后端 tool_call 事件翻译成人话 + 配图标
function describeToolCall(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
): { icon: React.ReactNode; label: string } {
  const path = typeof args?.path === 'string' ? args.path : ''
  switch (name) {
    case 'write_file':
      return { icon: <FilePlus size={12} />, label: `写入 ${path}` }
    case 'edit_file':
      // 局部编辑：只改文件里的一小段（差分编辑），区别于 write_file 的整文件写入
      return { icon: <FilePen size={12} />, label: `编辑 ${path}` }
    case 'read_files': {
      // paths 是字符串数组；工具调用刚出现时 args 可能还是空对象（流式提前亮卡阶段），
      // 这时 paths 拿不到，退回一个通用文案，等完整参数到达后会自动刷新成真实文件名。
      const paths = Array.isArray(args?.paths)
        ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      const label =
        paths.length === 0
          ? '读取文件'
          : paths.length === 1
            ? `读取 ${paths[0]}`
            : `批量读取 ${paths.length} 个文件`
      return { icon: <FileText size={12} />, label }
    }
    case 'list_files':
      return { icon: <FolderOpen size={12} />, label: '查看项目结构' }
    case 'check_build':
      return { icon: <Bug size={12} />, label: '构建预览并检查报错' }
    case 'ask_user':
      // 正常不会走到这条通用渲染路径（ask_user 由 AskUserChip 接管），
      // 这里只是兜底一致性，理论上不该被渲染出来。
      return { icon: <HelpCircle size={12} />, label: '向你确认一件事' }
    default:
      return { icon: <Wrench size={12} />, label: `调用工具 ${name ?? ''}` }
  }
}
