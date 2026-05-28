import { useEffect } from 'react'
import { useEditorStore } from '@/store/editor'
import { useSessionStore } from '@/store/session'
import EditorTabBar from './TabBar'
import MonacoView from './MonacoView'
import EmptyState from './EmptyState'
import styles from './index.module.scss'

// ============================================
// 编辑器区：Tab 栏 + Monaco
// ============================================
export default function Editor() {
  const activePath = useEditorStore((s) => s.activePath)
  const reset = useEditorStore((s) => s.reset)
  const currentVersion = useSessionStore((s) => s.currentVersion())

  // 默认打开第一个组件文件，让 demo 一进来就有内容可看
  useEffect(() => {
    if (activePath) return
    const preferred = [
      'src/App.tsx',
      'src/components/Hero.tsx',
      'package.json',
      Object.keys(currentVersion.files)[0],
    ].find((p) => p && p in currentVersion.files)
    if (preferred) reset(preferred)
  }, [activePath, currentVersion.files, reset])

  return (
    <div className={styles.editor}>
      <EditorTabBar />
      <div className={styles.body}>
        {activePath ? <MonacoView path={activePath} /> : <EmptyState />}
      </div>
    </div>
  )
}
