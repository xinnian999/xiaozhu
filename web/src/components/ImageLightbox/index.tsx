import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useUIStore } from '@/store/ui'
import styles from './index.module.scss'

// ============================================
// 全局图片放大预览层
// ============================================
// 挂在 App 根（和 Toast 同级），由 useUIStore.previewImage 驱动：
// 任意缩略图点击 → openImagePreview(src) 打开；点背景 / 关闭按钮 / Esc 关闭。
export default function ImageLightbox() {
  const src = useUIStore((s) => s.previewImage)
  const close = useUIStore((s) => s.closeImagePreview)

  // 打开期间监听 Esc 关闭；关闭（src 为 null）时不绑定
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src, close])

  if (!src) return null

  return (
    <div
      className={styles.overlay}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
    >
      <button className={styles.close} onClick={close} aria-label="关闭预览">
        <X size={20} />
      </button>
      {/* 点图片本身不关闭（阻止冒泡），只有点背景才关 */}
      <img
        src={src}
        className={styles.image}
        onClick={(e) => e.stopPropagation()}
        alt="图片预览"
      />
    </div>
  )
}
