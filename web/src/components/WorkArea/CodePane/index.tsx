import ActivityBar from './ActivityBar'
import FileTree from './FileTree'
import Editor from './Editor'
import styles from './index.module.scss'

// ============================================
// 代码视图：三栏（Activity Bar / 文件树 / 编辑器）
// ============================================
export default function CodePane() {
  return (
    <div className={styles.code}>
      <ActivityBar />
      <FileTree />
      <Editor />
    </div>
  )
}
