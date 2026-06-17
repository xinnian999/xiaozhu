import { useCallback, useRef, useState } from 'react'
import { Coins, ChevronDown, Sparkles } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import UpgradeDrawer from './UpgradeDrawer'
import { tierLabel } from './tiers'
import styles from './index.module.scss'

// ============================================
// 顶栏右上角：积分（今日剩余额度）标签
// ============================================
// 标签形如【🪙 14/15】，点击展开下拉：当前订阅档位 + 每日额度，底部「升级订阅」按钮，
// 点按钮弹出升级抽屉（后续接真实充值/支付）。额度状态从 store.billing 取，每轮对话后会刷新。

export default function CreditsBadge() {
  const billing = useSessionStore((s) => s.billing)

  const [open, setOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  // 额度还没拉到（未登录 / 加载中）就不渲染，避免出现空标签
  if (!billing) return null

  const empty = billing.remaining <= 0

  const openDrawer = () => {
    setOpen(false)
    setDrawerOpen(true)
  }

  return (
    <div className={styles.badge} ref={rootRef}>
      {/* 触发器：积分图标 + 今日剩余 / 每日额度 */}
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''} ${empty ? styles.triggerEmpty : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="今日剩余积分"
      >
        <Coins size={14} className={styles.coin} />
        <span className={styles.count}>
          {billing.remaining}
        </span>
        <ChevronDown size={12} className={styles.caret} />
      </button>

      {/* 下拉：当前档位 + 每日额度 + 升级按钮 */}
      {open && (
        <div className={styles.panel} role="menu" aria-label="积分与订阅">
          <div className={styles.row}>
            <span className={styles.rowLabel}>当前订阅</span>
            <span className={styles.rowValue}>{tierLabel(billing.tier)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>每日额度</span>
            <span className={styles.rowValue}>{billing.daily_allowance} 积分</span>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>今日剩余</span>
            <span className={`${styles.rowValue} ${empty ? styles.rowValueEmpty : ''}`}>
              {billing.remaining} 积分
            </span>
          </div>

          <div className={styles.divider} />

          {/* 说明：积分每日重置，隔天恢复满额 */}
          <p className={styles.hint}>积分每天 0 点重置，升级可获得更高每日额度。</p>

          <button type="button" className={styles.upgradeBtn} onClick={openDrawer}>
            <Sparkles size={14} />
            <span>升级订阅</span>
          </button>
        </div>
      )}

      {/* 升级抽屉（从右侧滑出） */}
      {drawerOpen && <UpgradeDrawer onClose={() => setDrawerOpen(false)} />}
    </div>
  )
}
