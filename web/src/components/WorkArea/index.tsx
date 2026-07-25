import { useEffect } from 'react'
import { useUIStore } from '@/store/ui'
import { useSessionStore } from '@/store/session'
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
  const restorePreviewDevice = useUIStore((s) => s.restorePreviewDevice)
  const activeId = useSessionStore((s) => s.activeId)

  // WorkArea 在项目间切换时不会卸载，因此显式按项目恢复用户最后选择的画布。
  // 首次刷新已由 UI store 根据 URL 同步初始化，这里同时覆盖应用内切换项目的场景。
  useEffect(() => {
    restorePreviewDevice(activeId)
  }, [activeId, restorePreviewDevice])

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
