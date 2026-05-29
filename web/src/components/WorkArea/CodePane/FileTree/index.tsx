import { useMemo, useState } from 'react'
import { FilePlus, FolderPlus, RotateCw, ChevronsDownUp } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { buildTree } from '@/lib/tree'
import TreeNode from './TreeNode'
import styles from './index.module.scss'

// ============================================
// 文件树面板
// ============================================
export default function FileTree() {
  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())

  // 默认展开的目录集合（首层 src 默认展开，让 demo 一进来就有信息）
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(['src', 'src/components']),
  )

  const nodes = useMemo(() => buildTree(currentVersion.files), [currentVersion.files])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const collapseAll = () => setExpanded(new Set())

  return (
    <aside className={styles.tree}>
      {/* 顶部项目名 + 工具行 */}
      <header className={styles.head}>
        <div className={styles.projectLabel}>
          <span className={styles.projectDot} aria-hidden />
          <span className={styles.projectName}>{session.name}</span>
        </div>

        <div className={styles.tools}>
          {/* MVP 不让用户改文件，按钮置灰 */}
          <button className={styles.toolBtn} title="新建文件（即将开放）" disabled>
            <FilePlus size={13} />
          </button>
          <button className={styles.toolBtn} title="新建文件夹（即将开放）" disabled>
            <FolderPlus size={13} />
          </button>
          <button className={styles.toolBtn} title="刷新（即将开放）" disabled>
            <RotateCw size={13} />
          </button>
          <button className={styles.toolBtn} title="折叠全部" onClick={collapseAll}>
            <ChevronsDownUp size={13} />
          </button>
        </div>
      </header>

      {/* 树本体 */}
      <div className={styles.list}>
        {nodes.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
          />
        ))}
      </div>

      {/* 底部统计 */}
      <footer className={styles.foot}>
        <span className={styles.footStat}>
          共 <strong>{Object.keys(currentVersion.files).length}</strong> 个文件
        </span>
        <span className={styles.footTag}>{currentVersion.id}</span>
      </footer>
    </aside>
  )
}
