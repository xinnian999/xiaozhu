import { useUIStore } from '@/store/ui'
import TabBar from './TabBar'
import PreviewPane from './PreviewPane'
import DataPane from './DataPane'
import CodePane from './CodePane'
import styles from './index.module.scss'

// ============================================
// 右侧工作区：tabs + 主面板
// ============================================
export default function WorkArea() {
  const workTab = useUIStore((s) => s.workTab)

  return (
    <section className={styles.work}>
      <TabBar />

      <div className={styles.body}>
        {/* 用条件渲染保留各自状态：预览 iframe 不会因 tab 切换而被销毁 */}
        <div className={styles.pane} style={{ display: workTab === 'preview' ? 'block' : 'none' }}>
          <PreviewPane />
        </div>
        <div className={styles.pane} style={{ display: workTab === 'code' ? 'flex' : 'none' }}>
          <CodePane />
        </div>
        <div className={styles.pane} style={{ display: workTab === 'data' ? 'block' : 'none' }}>
          <DataPane />
        </div>
      </div>
    </section>
  )
}
