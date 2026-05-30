import { useState } from 'react'
import { Sparkles, FileText, FilePlus, FolderOpen, Wrench, Bug, ChevronRight } from 'lucide-react'
import { formatClock } from '@/lib/format'
import type { Message } from '@/types/project'
import styles from './index.module.scss'

type Props = {
  message: Message
  /** 是否正在流式输出（显示光标动画，隐藏时间戳） */
  isStreaming?: boolean
}

// ============================================
// 单条对话气泡
// ============================================
// - kind === 'tool'：渲染成"工具调用进度卡"，紧凑显示工具名 + 关键参数
// - 其余情况：渲染成普通文本气泡
export default function MessageBubble({ message, isStreaming = false }: Props) {
  if (message.kind === 'tool') {
    return <ToolCallChip message={message} />
  }

  const isUser = message.role === 'user'

  return (
    <article className={`${styles.bubble} ${isUser ? styles.user : styles.assistant}`}>
      {!isUser && (
        <span className={styles.avatar} aria-hidden>
          <Sparkles size={12} />
        </span>
      )}

      <div className={styles.content}>
        <p className={styles.text}>
          {message.text}
          {/* 流式输出时在文字末尾追加闪烁光标 */}
          {isStreaming && <span className={styles.cursor} aria-hidden />}
        </p>

        {!isStreaming && (
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
// 一行细窄卡片，避免抢眼。带参数的工具可点击展开，查看完整参数（如 write_file
// 的文件内容）；无参数的工具（list_files / get_browser_logs）纯展示、不可展开。
function ToolCallChip({ message }: { message: Message }) {
  const { icon, label } = describeToolCall(message.toolName, message.toolArgs)
  const args = message.toolArgs
  // 有参数才可展开 —— 否则展开只会看到空对象，没意义
  const hasArgs = !!args && Object.keys(args).length > 0
  const [expanded, setExpanded] = useState(false)

  // 头部内容（图标 + 文案 + 可展开时的箭头）两种渲染路径共用
  const inner = (
    <>
      <span className={styles.toolChipIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.toolChipLabel}>{label}</span>
      {hasArgs && (
        <ChevronRight
          size={12}
          className={`${styles.toolChipChevron} ${expanded ? styles.toolChipChevronOpen : ''}`}
          aria-hidden
        />
      )}
    </>
  )

  return (
    <div className={`${styles.toolChip} ${hasArgs ? styles.toolChipExpandable : ''}`}>
      {hasArgs ? (
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

      {hasArgs && expanded && <pre className={styles.toolChipArgs}>{formatArgs(args)}</pre>}
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
    case 'read_file':
      return { icon: <FileText size={12} />, label: `读取 ${path}` }
    case 'list_files':
      return { icon: <FolderOpen size={12} />, label: '查看项目结构' }
    case 'get_browser_logs':
      return { icon: <Bug size={12} />, label: '检查预览报错' }
    default:
      return { icon: <Wrench size={12} />, label: `调用工具 ${name ?? ''}` }
  }
}
