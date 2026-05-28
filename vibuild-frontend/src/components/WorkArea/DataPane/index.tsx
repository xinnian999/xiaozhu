import { Database } from 'lucide-react'
import styles from './index.module.scss'

// ============================================
// 数据面板：MVP 仅占位
// ============================================
export default function DataPane() {
  return (
    <div className={styles.data}>
      <div className={styles.bgGrid} aria-hidden />

      <div className={styles.center}>
        <div className={styles.iconBox}>
          <Database size={28} strokeWidth={1.5} />
        </div>

        <h2 className={styles.title}>
          数据层 <span className={styles.italic}>即将到来</span>
        </h2>

        <p className={styles.desc}>
          这里将托管生成项目的数据库 schema、表数据和查询编辑器。
          MVP 阶段先聚焦于代码生成 / 预览 / 下载闭环。
        </p>

        <div className={styles.timeline}>
          <span className={styles.timelineItem}>
            <i className={styles.dot} />
            <span>M3</span>
            <em>WebContainer 接入</em>
          </span>
          <span className={styles.timelineItem}>
            <i className={styles.dot} />
            <span>M4</span>
            <em>会话与持久化</em>
          </span>
          <span className={styles.timelineItem}>
            <i className={`${styles.dot} ${styles.pending}`} />
            <span>M6+</span>
            <em>数据层（本面板）</em>
          </span>
        </div>
      </div>
    </div>
  )
}
