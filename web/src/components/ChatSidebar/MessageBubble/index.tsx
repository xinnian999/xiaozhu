import { useState } from 'react'
import { FileText, FilePlus, FilePen, FolderOpen, Wrench, Bug, ChevronRight, GitCommit, RotateCcw, Loader2, Check, AlertCircle } from 'lucide-react'
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
}

// ============================================
// 单条对话气泡
// ============================================
// - kind === 'tool'：渲染成"工具调用进度卡"，紧凑显示工具名 + 关键参数
// - kind === 'version'：渲染成"版本卡"，附带回滚按钮
// - 其余情况：渲染成普通文本气泡
export default function MessageBubble({ message, isStreaming = false, isLast = false }: Props) {
  // 必须在任何条件 return 之前调用 hook（Hooks 规则）
  const openImagePreview = useUIStore((s) => s.openImagePreview)

  if (message.kind === 'tool') {
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
          <time className={styles.time} dateTime={new Date(message.createdAt).toISOString()}>
            {formatClock(message.createdAt)}
          </time>
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
  // 有参数或有结果都可展开；都没有（如刚发起、结果还没回来）则纯展示
  const expandable = hasArgs || hasResult
  const [expanded, setExpanded] = useState(false)

  // 头部内容（图标 + 文案 + 可展开时的箭头）两种渲染路径共用
  const inner = (
    <>
      <span className={styles.toolChipIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.toolChipLabel}>{label}</span>
      {expandable && (
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
    case 'read_file':
      return { icon: <FileText size={12} />, label: `读取 ${path}` }
    case 'list_files':
      return { icon: <FolderOpen size={12} />, label: '查看项目结构' }
    case 'check_build':
      return { icon: <Bug size={12} />, label: '构建预览并检查报错' }
    default:
      return { icon: <Wrench size={12} />, label: `调用工具 ${name ?? ''}` }
  }
}
