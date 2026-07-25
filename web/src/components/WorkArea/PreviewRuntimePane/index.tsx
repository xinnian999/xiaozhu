import { useEffect, useState } from 'react'
import { getPreviewRuntime, type PreviewRuntime } from '@/lib/api'
import PreviewPane from '../PreviewPane'
import ServerPreviewPane from '../ServerPreviewPane'
import styles from '../PreviewPane/index.module.scss'

/** 部署级运行时路由：默认 WebContainer，显式开启后才加载实验性的后端 Worker。 */
export default function PreviewRuntimePane() {
  const [runtime, setRuntime] = useState<PreviewRuntime | null>(null)

  useEffect(() => {
    let cancelled = false
    void getPreviewRuntime().then((value) => {
      if (!cancelled) setRuntime(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (runtime === 'server') return <ServerPreviewPane />
  if (runtime === 'webcontainer') return <PreviewPane />
  return (
    <div className={styles.preview}>
      <div className={styles.frame}>
        <div className={styles.browser}>
          <div className={styles.viewport}>
            <div className={styles.overlay}>正在读取预览运行时…</div>
          </div>
        </div>
      </div>
    </div>
  )
}
