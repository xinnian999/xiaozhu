import { useEffect, useRef, useState } from 'react'
import { X, Check, Loader2, ArrowLeft } from 'lucide-react'
import QRCode from 'qrcode'
import { useSessionStore } from '@/store/session'
import { getPlans, createOrder, getOrderStatus, type ApiPlan, type ApiOrder } from '@/lib/api'
import { toast } from '@/lib/toast'
import { tierLabel, TIER_BLURB } from '../tiers'
import styles from './index.module.scss'

// ============================================
// 升级订阅抽屉：从右侧滑出，列出套餐 → 下单 → 扫码支付
// ============================================
// 流程：点某档「升级」→ 调后端下单拿二维码 → 切到支付视图渲染二维码 → 每 2 秒轮询订单状态
//（后端会主动问支付宝）→ 一旦 paid，刷新额度 + 提示 + 关闭。
// 真实支付走支付宝沙箱：用沙箱版支付宝 App 扫码付款即可完成。

type Props = {
  onClose: () => void
}

// 轮询间隔（毫秒）
const POLL_MS = 2000

export default function UpgradeDrawer({ onClose }: Props) {
  const billing = useSessionStore((s) => s.billing)
  const loadBilling = useSessionStore((s) => s.loadBilling)

  const [plans, setPlans] = useState<ApiPlan[]>([])
  // 当前正在支付的订单（含二维码）；null = 还在套餐列表视图
  const [order, setOrder] = useState<ApiOrder | null>(null)
  // 二维码图片（data URL），由 order.qr_code 渲染而来
  const [qrDataUrl, setQrDataUrl] = useState<string>('')
  // 正在下单的档位（按钮 loading 用）
  const [creating, setCreating] = useState<string | null>(null)

  const currentTier = billing?.tier

  // 打开时拉套餐列表
  useEffect(() => {
    getPlans()
      .then(setPlans)
      .catch(() => toast('套餐列表加载失败'))
  }, [])

  // 进入支付视图：把 qr_code 字符串渲染成二维码图片
  useEffect(() => {
    if (!order) {
      setQrDataUrl('')
      return
    }
    QRCode.toDataURL(order.qr_code, { width: 220, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => toast('二维码生成失败'))
  }, [order])

  // 进入支付视图后轮询订单状态，paid 即收尾。用 ref 存定时器，便于清理。
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!order) return
    const tick = async () => {
      try {
        const s = await getOrderStatus(order.order_id)
        if (s.status === 'paid') {
          if (timerRef.current) clearInterval(timerRef.current)
          await loadBilling() // 升档已在后端完成，这里把前端额度刷新到最新
          toast(`支付成功，已升级到${tierLabel(order.tier)}`)
          onClose()
        }
      } catch {
        // 轮询途中的偶发错误忽略，下个 tick 再试
      }
    }
    timerRef.current = setInterval(tick, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [order, loadBilling, onClose])

  // 点某档「升级」：下单 → 进支付视图
  const handlePick = async (tier: string) => {
    if (creating) return
    setCreating(tier)
    try {
      const o = await createOrder(tier)
      setOrder(o)
    } catch {
      // 错误已由 axios 拦截器 toast
    } finally {
      setCreating(null)
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
          {order ? (
            <button
              type="button"
              className={styles.backBtn}
              onClick={() => setOrder(null)}
              aria-label="返回套餐"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span />
          )}
          <h2 className={styles.title}>{order ? '扫码支付' : '升级订阅'}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {order ? (
          // ── 支付视图：二维码 + 等待轮询 ──
          <div className={styles.pay}>
            <p className={styles.paySubtitle}>
              升级到 <b>{tierLabel(order.tier)}</b>，应付 <b>¥{order.amount}</b>
            </p>
            <div className={styles.qrBox}>
              {qrDataUrl ? (
                <img className={styles.qrImg} src={qrDataUrl} alt="支付二维码" />
              ) : (
                <Loader2 size={22} className={styles.spin} />
              )}
            </div>
            <p className={styles.payHint}>
              <Loader2 size={13} className={styles.spin} />
              请用支付宝扫码支付，支付后自动到账…
            </p>
          </div>
        ) : (
          // ── 套餐列表视图 ──
          <>
            <p className={styles.subtitle}>选择套餐，获得更高的每日积分额度。</p>
            <div className={styles.plans}>
              {plans.map((p) => {
                const isCurrent = p.tier === currentTier
                const isFree = p.price === null
                const isBusy = creating === p.tier
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

                    {/* free 不可购买，只作展示；pro/max 显示价格 + 升级按钮 */}
                    {isFree ? (
                      <div className={styles.planFree}>{isCurrent ? '当前免费版' : '基础版'}</div>
                    ) : (
                      <button
                        type="button"
                        className={styles.planBtn}
                        disabled={isBusy}
                        onClick={() => handlePick(p.tier)}
                      >
                        {isBusy ? (
                          <>
                            <Loader2 size={14} className={styles.spin} />
                            下单中
                          </>
                        ) : (
                          `¥${p.price} 升级`
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <p className={styles.footnote}>支付宝沙箱支付，用沙箱版支付宝 App 扫码完成。</p>
          </>
        )}
      </aside>
    </div>
  )
}
