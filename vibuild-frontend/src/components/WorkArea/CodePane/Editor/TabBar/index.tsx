import { X, Download, Maximize2 } from 'lucide-react'
import { useEditorStore } from '@/store/editor'
import { useSessionStore } from '@/store/session'
import { useUIStore } from '@/store/ui'
import { saveAs } from 'file-saver'
import styles from './index.module.scss'

// ============================================
// Editor 顶部 Tab 栏（多文件 tab）
// ============================================
export default function EditorTabBar() {
  const openPaths = useEditorStore((s) => s.openPaths)
  const activePath = useEditorStore((s) => s.activePath)
  const openFile = useEditorStore((s) => s.openFile)
  const closeFile = useEditorStore((s) => s.closeFile)
  const currentVersion = useSessionStore((s) => s.currentVersion())
  const pushToast = useUIStore((s) => s.pushToast)

  const onDownloadFile = () => {
    if (!activePath) return
    const content = currentVersion.files[activePath]
    if (content == null) return
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    saveAs(blob, activePath.split('/').pop()!)
    pushToast(`已下载 ${activePath}`)
  }

  return (
    <div className={styles.tabbar}>
      <div className={styles.tabs}>
        {openPaths.map((p) => {
          const name = p.split('/').pop()!
          const isActive = p === activePath
          return (
            <div
              key={p}
              className={`${styles.tab} ${isActive ? styles.active : ''}`}
              onClick={() => openFile(p)}
              title={p}
            >
              <span className={styles.tabName}>{name}</span>
              <button
                className={styles.close}
                aria-label={`关闭 ${name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeFile(p)
                }}
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>

      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={onDownloadFile}
          disabled={!activePath}
          title="下载当前文件"
          aria-label="下载当前文件"
        >
          <Download size={13} />
        </button>
        <button
          className={styles.actionBtn}
          disabled
          title="全屏（即将开放）"
          aria-label="全屏"
        >
          <Maximize2 size={13} />
        </button>
      </div>
    </div>
  )
}
