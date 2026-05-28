import { ChevronRight, Folder, FolderOpen, FileText, FileCode, FileJson, FileType } from 'lucide-react'
import { useEditorStore } from '@/store/editor'
import type { TreeNode as TNode } from '@/lib/tree'
import styles from './index.module.scss'

// ============================================
// 树节点：递归渲染
// ============================================
type Props = {
  node: TNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
}

// 根据文件名给出图标 + 颜色
function pickFileIcon(name: string) {
  if (name === 'package.json' || name.endsWith('.json')) {
    return { Icon: FileJson, color: '#facc15' }
  }
  if (/\.(ts|tsx)$/.test(name)) {
    return { Icon: FileCode, color: '#38bdf8' }
  }
  if (/\.(js|jsx|mjs|cjs)$/.test(name)) {
    return { Icon: FileCode, color: '#fbbf24' }
  }
  if (/\.(css|scss|less)$/.test(name)) {
    return { Icon: FileType, color: '#a78bfa' }
  }
  if (/\.(md|mdx)$/.test(name)) {
    return { Icon: FileText, color: '#94a3b8' }
  }
  if (name === '.gitignore' || name.startsWith('.')) {
    return { Icon: FileText, color: '#64748b' }
  }
  return { Icon: FileText, color: 'var(--color-text-mute)' }
}

export default function TreeNode({ node, depth, expanded, onToggle }: Props) {
  const openFile = useEditorStore((s) => s.openFile)
  const activePath = useEditorStore((s) => s.activePath)

  const isExpanded = expanded.has(node.path)
  const isActive = node.path === activePath
  const indent = depth * 12

  if (node.isDir) {
    return (
      <>
        <button
          className={`${styles.row} ${styles.dirRow}`}
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node.path)}
        >
          <ChevronRight
            size={12}
            className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`}
          />
          {isExpanded
            ? <FolderOpen size={13} className={styles.dirIcon} />
            : <Folder size={13} className={styles.dirIcon} />}
          <span className={styles.name}>{node.name}</span>
        </button>

        {isExpanded && node.children?.map((c) => (
          <TreeNode
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
      </>
    )
  }

  // 文件节点
  const { Icon, color } = pickFileIcon(node.name)

  return (
    <button
      className={`${styles.row} ${styles.fileRow} ${isActive ? styles.fileActive : ''}`}
      style={{ paddingLeft: 8 + indent + 12 /* 给 chevron 留位 */ }}
      onClick={() => openFile(node.path)}
    >
      <Icon size={13} style={{ color }} className={styles.fileIcon} />
      <span className={styles.name}>{node.name}</span>
      {isActive && <span className={styles.activeDot} aria-hidden />}
    </button>
  )
}
