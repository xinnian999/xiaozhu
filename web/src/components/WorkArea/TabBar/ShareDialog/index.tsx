import { useEffect, useRef, useState } from 'react'
import { X, Copy, ExternalLink, Loader2, Check, AlertTriangle } from 'lucide-react'
import { buildDist } from '@/lib/webcontainer'
import { shareBuild, revokeShare, shareUrl } from '@/lib/api'
import { toast } from '@/lib/toast'
import styles from './index.module.scss'

// ============================================
// 分享弹窗：打开即「构建 → 上传」，完成后给出可复制的访客链接
// ============================================
// 流程见和用户的讨论：在分享者自己的 WebContainer 里 vite build 出 dist，
// 上传给后端静态托管，访客打开链接秒开、不碰 WebContainer。

type Phase = 'building' | 'ready' | 'error'

type Props = {
  sessionId: string
  onClose: () => void
}

export default function ShareDialog({ sessionId, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('building')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState(false)

  // StrictMode 下 effect 会跑两次；用 ref 保证「构建+上传」只触发一次
  const startedRef = useRef(false)

  // 真正的构建 + 上传流程，抽出来供首次进入和「重试」复用
  const run = async () => {
    setPhase('building')
    setError(null)
    try {
      // 1. 在容器里构建出 dist
      const built = await buildDist()
      // 2. 上传，拿回 share token
      const token = await shareBuild(
        sessionId,
        built.map((f) => ({ path: f.path, content: f.content, is_base64: f.isBase64 })),
      )
      setUrl(shareUrl(token))
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast('复制失败，请手动选中链接复制')
    }
  }

  const handleRevoke = async () => {
    if (revoking) return
    setRevoking(true)
    try {
      await revokeShare(sessionId)
      toast('已停止分享，旧链接立即失效')
      onClose()
    } catch {
      // 错误已由 axios 拦截器 toast
    } finally {
      setRevoking(false)
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

        {/* 构建中 */}
        {phase === 'building' && (
          <div className={styles.center}>
            <Loader2 size={28} className={styles.spin} />
            <p className={styles.centerText}>正在构建预览快照…</p>
            <p className={styles.hint}>首次构建可能要十几秒，构建好后访客打开秒开</p>
          </div>
        )}

        {/* 出错 */}
        {phase === 'error' && (
          <div className={styles.center}>
            <AlertTriangle size={26} className={styles.errIcon} />
            <p className={styles.centerText}>构建失败</p>
            <p className={styles.hint}>{error}</p>
            <button type="button" className={styles.primaryBtn} onClick={run}>
              重试
            </button>
          </div>
        )}

        {/* 完成 */}
        {phase === 'ready' && (
          <>
            <p className={styles.desc}>把链接发给任何人，打开即看到这个应用的运行效果（无需登录）。</p>

            <div className={styles.linkRow}>
              <input className={styles.linkInput} value={url} readOnly onFocus={(e) => e.target.select()} />
              <button type="button" className={styles.iconBtn} onClick={handleCopy} title="复制链接">
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
              <a
                className={styles.iconBtn}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title="新窗口打开"
              >
                <ExternalLink size={15} />
              </a>
            </div>

            <p className={styles.hint}>
              分享的是当前快照；之后修改了项目，需要重新点分享来更新。
            </p>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={handleRevoke}
                disabled={revoking}
              >
                {revoking ? <Loader2 size={14} className={styles.spin} /> : '停止分享'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
