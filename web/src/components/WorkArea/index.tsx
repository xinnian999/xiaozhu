import { useUIStore } from '@/store/ui'
import TabBar from './TabBar'
import PreviewPane from './PreviewPane'
import CodePane from './CodePane'
import ConsolePanel from './ConsolePanel'
import styles from './index.module.scss'

// ============================================
// 右侧工作区：tabs + 主面板 + 控制台抽屉
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

        {/* 控制台抽屉：浮在 preview / code 之上，consoleOpen 为真时显示 */}
        <ConsolePanel />
      </div>
    </section>
  )
}
