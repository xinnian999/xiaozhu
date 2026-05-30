import { Sparkles, FileText, FilePlus, FolderOpen, Wrench } from 'lucide-react'
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
// 不是完整气泡，而是一行细窄卡片，避免抢眼。点击后续可考虑展开参数详情。
function ToolCallChip({ message }: { message: Message }) {
  const { icon, label } = describeToolCall(message.toolName, message.toolArgs)
  return (
    <div className={styles.toolChip} role="status" aria-label={label}>
      <span className={styles.toolChipIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.toolChipLabel}>{label}</span>
    </div>
  )
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
    default:
      return { icon: <Wrench size={12} />, label: `调用工具 ${name ?? ''}` }
  }
}
