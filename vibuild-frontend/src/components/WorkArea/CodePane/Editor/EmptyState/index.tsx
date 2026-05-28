import { FileCode2 } from 'lucide-react'
import styles from './index.module.scss'

// ============================================
// 编辑器空态：所有 tab 都被关闭后显示
// ============================================
export default function EmptyState() {
  return (
    <div className={styles.empty}>
      <div className={styles.box}>
        <div className={styles.icon}>
          <FileCode2 size={28} strokeWidth={1.4} />
        </div>
        <h3>没有打开的文件</h3>
        <p>从左侧文件树选择一个文件以查看内容</p>
        <div className={styles.shortcuts}>
          <span><kbd>P</kbd> 快速跳转</span>
          <span><kbd>⌘</kbd> + <kbd>B</kbd> 切换文件树</span>
        </div>
      </div>
    </div>
  )
}
