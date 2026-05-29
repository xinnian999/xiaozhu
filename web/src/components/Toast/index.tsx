import { Check } from 'lucide-react'
import { useUIStore } from '@/store/ui'
import styles from './index.module.scss'

// ============================================
// 全局 Toast：浮在右下角
// ============================================
export default function Toast() {
  const toast = useUIStore((s) => s.toast)
  if (!toast) return null

  return (
    <div className={styles.toast} key={toast.id}>
      <span className={styles.icon}>
        <Check size={12} strokeWidth={3} />
      </span>
      <span className={styles.text}>{toast.text}</span>
    </div>
  )
}
