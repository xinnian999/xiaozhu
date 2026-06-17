import { useEffect, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { getPlans, type ApiPlan } from '@/lib/api'
import { toast } from '@/lib/toast'
import { tierLabel, TIER_BLURB } from '../tiers'
import styles from './index.module.scss'

// ============================================
// 升级订阅抽屉：从右侧滑出，列出各档套餐
// ============================================
// 当前阶段：点某档 → 调 dev 改档接口直接切过去（真实支付接入前的占位）。
// ⚠️ 后续接入支付后，这里的「切换」要改成「跳支付 → 成功后由 webhook 改档」，
//    不能再让前端直接免费切档（详见后端 billing.py 的警告）。

type Props = {
  onClose: () => void
}

export default function UpgradeDrawer({ onClose }: Props) {
  const billing = useSessionStore((s) => s.billing)
  const changeTier = useSessionStore((s) => s.changeTier)

  const [plans, setPlans] = useState<ApiPlan[]>([])
  // 正在切换的目标档位（按钮 loading 用）；null 表示当前没有在切
  const [switching, setSwitching] = useState<string | null>(null)

  // 打开时拉套餐列表（每日额度由后端派生，前端不硬编码数字）
  useEffect(() => {
    getPlans()
      .then(setPlans)
      .catch(() => toast('套餐列表加载失败'))
  }, [])

  const currentTier = billing?.tier

  const handlePick = async (tier: string) => {
    if (switching || tier === currentTier) return
    setSwitching(tier)
    try {
      await changeTier(tier)
      toast(`已切换到${tierLabel(tier)}`)
    } catch {
      // 错误已由 axios 拦截器 toast
    } finally {
      setSwitching(null)
    }
  }

  return (
    // 遮罩：点空白处关闭
    <div className={styles.overlay} onClick={onClose}>
      {/* 抽屉本体：阻止冒泡，点内部不关闭 */}
      <aside
        className={styles.drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="升级订阅"
      >
        <div className={styles.header}>
          <h2 className={styles.title}>升级订阅</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <p className={styles.subtitle}>选择套餐，获得更高的每日积分额度。</p>

        <div className={styles.plans}>
          {plans.map((p) => {
            const isCurrent = p.tier === currentTier
            const isBusy = switching === p.tier
            return (
              <div
                key={p.tier}
                className={`${styles.plan} ${isCurrent ? styles.planCurrent : ''}`}
              >
                <div className={styles.planHead}>
                  <span className={styles.planName}>{tierLabel(p.tier)}</span>
                  {isCurrent && <span className={styles.planTag}>当前</span>}
                </div>
                <div className={styles.planCredits}>
                  {p.daily_allowance}
                  <span className={styles.planCreditsUnit}> 积分/天</span>
                </div>
                <p className={styles.planBlurb}>{TIER_BLURB[p.tier] ?? ''}</p>

                <button
                  type="button"
                  className={styles.planBtn}
                  disabled={isCurrent || isBusy}
                  onClick={() => handlePick(p.tier)}
                >
                  {isCurrent ? (
                    <>
                      <Check size={14} />
                      使用中
                    </>
                  ) : isBusy ? (
                    <>
                      <Loader2 size={14} className={styles.spin} />
                      切换中
                    </>
                  ) : (
                    '选择'
                  )}
                </button>
              </div>
            )
          })}
        </div>

        {/* 占位说明：真实支付未接入，当前为开发期直接切档 */}
        <p className={styles.footnote}>支付通道开发中，当前为体验版直接切换。</p>
      </aside>
    </div>
  )
}
