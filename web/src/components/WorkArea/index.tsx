import { useEffect } from 'react'
import { useUIStore } from '@/store/ui'
import { useSessionStore } from '@/store/session'
import TabBar from './TabBar'
import ServerPreviewPane from './ServerPreviewPane'
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
        {/* 预览切到代码页后仍在画布外运行，保证生成中的运行时验收不会因 iframe 尺寸归零而暂停。 */}
        <div className={`${styles.pane} ${workTab === 'preview' ? '' : styles.paneHidden}`}>
          <ServerPreviewPane />
        </div>
        <div
          className={`${styles.pane} ${workTab === 'code' ? styles.paneForeground : ''}`}
          style={{ display: workTab === 'code' ? 'flex' : 'none' }}
        >
          <CodePane />
        </div>

        {/* 控制台抽屉：浮在 preview / code 之上，consoleOpen 为真时显示 */}
        <ConsolePanel />
      </div>
    </section>
  )
}
