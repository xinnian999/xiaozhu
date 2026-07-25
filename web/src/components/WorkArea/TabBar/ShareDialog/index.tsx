import { useState } from 'react'
import { X, Copy, ExternalLink, Check } from 'lucide-react'
import { toast } from '@/lib/toast'
import styles from './index.module.scss'

type Props = {
  previewUrl: string
  onClose: () => void
}

/** Worker 预览地址已经是可访问的独立 Origin，直接复制当前构建链接。 */
export default function ShareDialog({ previewUrl, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(previewUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast('复制失败，请手动选中链接复制')
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>分享预览</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <p className={styles.desc}>把链接发给任何人，打开即可查看当前后端沙箱构建。</p>

        <div className={styles.linkRow}>
          <input className={styles.linkInput} value={previewUrl} readOnly onFocus={(e) => e.target.select()} />
          <button type="button" className={styles.iconBtn} onClick={handleCopy} title="复制链接">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
          <a
            className={styles.iconBtn}
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="新窗口打开"
          >
            <ExternalLink size={15} />
          </a>
        </div>

        <p className={styles.hint}>每个项目仅保留最近 3 次构建；继续生成后旧链接可能失效。</p>
      </div>
    </div>
  )
}
