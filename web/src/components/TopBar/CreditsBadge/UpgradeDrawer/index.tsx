import { useEffect, useRef, useState } from 'react'
import { X, Loader2, ArrowLeft, Clock } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import {
  getPlans,
  createOrder,
  claimOrder,
  getOrderStatus,
  getMyPendingOrder,
  type ApiPlan,
  type ApiOrder,
} from '@/lib/api'
import { toast } from '@/lib/toast'
import { tierLabel, TIER_BLURB, tierRank } from '../tiers'
import styles from './index.module.scss'

// ============================================
// 升级订阅抽屉：从右侧滑出，列出套餐 → 下单看收款码 → 「我已支付」→ 等人工审核
// ============================================
// 收款是「手动核对」模式（个人微信/支付宝收款码）：
//   点某档「升级」→ 下单拿收款码 → 用户扫码付款 → 选支付方式 + 填备注 → 点「我已支付」
//   → 订单转「待审核」（后端给运营发邮件）→ 运营人工核对到账后放行升档。
// 因为审核是人工、可能较久，前端只在「待审核」态 + 抽屉打开时慢轮询（15s），关掉即停。
//
// 待审核态是「跨会话持久」的：抽屉打开时先查 /my-order，若已有待审核订单，直接进待审核态、
// 并把对应档位的升级按钮置灰为「已支付·待审核」，避免关掉抽屉重开又看到「升级」按钮、重复下单。

type Props = {
  onClose: () => void
}

// 慢轮询间隔（毫秒）：审核靠人工，不做高频轮询。只为「运营恰好很快审了」时能自动刷新。
const POLL_MS = 15000

// 抽屉内部视图：套餐列表 / 看收款码付款 / 已支付待审核
type View = 'plans' | 'paying' | 'reviewing'

// 待审核态渲染所需的最小订单信息（下单返回的 ApiOrder 和 /my-order 都能满足）
type ReviewOrder = { order_id: string; tier: string; contact: string }

export default function UpgradeDrawer({ onClose }: Props) {
  const billing = useSessionStore((s) => s.billing)
  const loadBilling = useSessionStore((s) => s.loadBilling)

  const [plans, setPlans] = useState<ApiPlan[]>([])
  // 当前订单（含收款码信息）；null = 还在套餐列表
  const [order, setOrder] = useState<ApiOrder | null>(null)
  // 待审核态的订单（可能来自本次 claim，也可能来自打开时查到的历史未结订单）
  const [reviewOrder, setReviewOrder] = useState<ReviewOrder | null>(null)
  // 当前视图
  const [view, setView] = useState<View>('plans')
  // 用户在收款码视图选的支付方式
  const [method, setMethod] = useState<'wechat' | 'alipay'>('wechat')
  // 付款备注（尾号等）
  const [payNote, setPayNote] = useState('')
  // 正在下单的档位（按钮 loading）
  const [creating, setCreating] = useState<string | null>(null)
  // 正在提交「我已支付」
  const [claiming, setClaiming] = useState(false)

  const currentTier = billing?.tier

  // 打开时拉套餐列表 + 查有无未结订单（有待审核就直接进待审核态）
  useEffect(() => {
    getPlans()
      .then(setPlans)
      .catch(() => toast('套餐列表加载失败'))
    getMyPendingOrder()
      .then((o) => {
        // 已有「待审核」订单：直接进待审核态，避免又看到升级按钮
        if (o && o.status === 'pending_review') {
          setReviewOrder({ order_id: o.order_id, tier: o.tier, contact: o.contact })
          setView('reviewing')
        }
      })
      .catch(() => {
        // 查不到不影响正常下单流程
      })
  }, [])


  // 只在「待审核」态慢轮询订单状态；paid → 升级成功，rejected → 提示驳回。
  // 抽屉关闭（组件卸载）会清定时器停止轮询。
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (view !== 'reviewing' || !reviewOrder) return
    const tick = async () => {
      try {
        const s = await getOrderStatus(reviewOrder.order_id)
        if (s.status === 'paid') {
          if (timerRef.current) clearInterval(timerRef.current)
          await loadBilling() // 升档已在后端完成，这里把前端额度刷新到最新
          toast(`审核通过，已升级到${tierLabel(reviewOrder.tier)}`)
          onClose()
        } else if (s.status === 'rejected') {
          if (timerRef.current) clearInterval(timerRef.current)
          toast('订单被驳回，请核对后重新下单或联系客服')
          // 驳回后回到套餐列表，让用户可重新下单
          setReviewOrder(null)
          setView('plans')
        }
      } catch {
        // 轮询途中的偶发错误忽略，下个 tick 再试
      }
    }
    timerRef.current = setInterval(tick, POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [view, reviewOrder, loadBilling, onClose])

  // 点某档「升级」：下单 → 进收款码视图
  const handlePick = async (tier: string) => {
    if (creating) return
    setCreating(tier)
    try {
      const o = await createOrder(tier)
      setOrder(o)
      setMethod('wechat')
      setPayNote('')
      setView('paying')
    } catch {
      // 错误已由 axios 拦截器 toast
    } finally {
      setCreating(null)
    }
  }

  // 点「我已支付」：转待审核 + 进等待视图
  const handleClaim = async () => {
    if (!order || claiming) return
    setClaiming(true)
    try {
      await claimOrder(order.order_id, {
        payment_method: method,
        pay_note: payNote.trim() || undefined,
      })
      setReviewOrder({ order_id: order.order_id, tier: order.tier, contact: order.contact })
      setView('reviewing')
    } catch {
      // 错误已由 axios 拦截器 toast
    } finally {
      setClaiming(false)
    }
  }

  // 顶部标题随视图变化
  const headerTitle =
    view === 'plans' ? '升级订阅' : view === 'paying' ? '扫码支付' : '等待审核'

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
          {/* 收款码视图可返回套餐列表；待审核态不给返回（避免误以为能撤销） */}
          {view === 'paying' ? (
            <button
              type="button"
              className={styles.backBtn}
              onClick={() => setView('plans')}
              aria-label="返回套餐"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span />
          )}
          <h2 className={styles.title}>{headerTitle}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        {view === 'plans' && (
          <PlansView
            plans={plans}
            currentTier={currentTier}
            creating={creating}
            reviewingTier={reviewOrder?.tier}
            onPick={handlePick}
          />
        )}

        {view === 'paying' && order && (
          <PayingView
            order={order}
            method={method}
            onMethodChange={setMethod}
            payNote={payNote}
            onPayNoteChange={setPayNote}
            claiming={claiming}
            onClaim={handleClaim}
          />
        )}

        {view === 'reviewing' && reviewOrder && <ReviewingView order={reviewOrder} />}
      </aside>
    </div>
  )
}

// PLACEHOLDER_SUBVIEWS

// ── 套餐列表视图 ──
type PlansViewProps = {
  plans: ApiPlan[]
  currentTier?: string
  creating: string | null
  reviewingTier?: string // 有待审核订单的档位：该档按钮置为「已支付·待审核」
  onPick: (tier: string) => void
}

function PlansView({ plans, currentTier, creating, reviewingTier, onPick }: PlansViewProps) {
  return (
    <>
      <p className={styles.subtitle}>选择套餐，获得更高的每日积分额度。</p>
      <div className={styles.plans}>
        {plans.map((p) => {
          const isCurrent = p.tier === currentTier
          const isBusy = creating === p.tier
          // 该档已有待审核订单：按钮置灰为「已支付·待审核」，避免重复下单
          const isReviewing = p.tier === reviewingTier
          // 只能升级：比当前档高才可点；当前档 / 更低档都不可点
          const canUpgrade = tierRank(p.tier) > tierRank(currentTier ?? 'free')
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

              {/* 优先级：当前套餐 > 待审核 > 可升级 > 不可降级 */}
              {isCurrent ? (
                <div className={styles.planNote}>当前套餐</div>
              ) : isReviewing ? (
                <div className={styles.planNote}>已支付·待审核</div>
              ) : canUpgrade ? (
                <button
                  type="button"
                  className={styles.planBtn}
                  disabled={isBusy}
                  onClick={() => onPick(p.tier)}
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
              ) : (
                <div className={styles.planNote}>不可降级</div>
              )}
            </div>
          )
        })}
      </div>
      <p className={styles.footnote}>
        扫码支付后点「我已支付」，我们会人工核对到账后为你升级。
      </p>
    </>
  )
}

// ── 看收款码付款视图 ──
type PayingViewProps = {
  order: ApiOrder
  method: 'wechat' | 'alipay'
  onMethodChange: (m: 'wechat' | 'alipay') => void
  payNote: string
  onPayNoteChange: (v: string) => void
  claiming: boolean
  onClaim: () => void
}

function PayingView({
  order,
  method,
  onMethodChange,
  payNote,
  onPayNoteChange,
  claiming,
  onClaim,
}: PayingViewProps) {
  // 当前支付方式对应的收款码图片
  const qr = method === 'wechat' ? order.qr_wechat : order.qr_alipay
  return (
    <div className={styles.pay}>
      <p className={styles.paySubtitle}>
        升级到 <b>{tierLabel(order.tier)}</b>，应付 <b>¥{order.amount}</b>
      </p>

      {/* 支付方式切换 */}
      <div className={styles.methodTabs}>
        <button
          type="button"
          className={`${styles.methodTab} ${method === 'wechat' ? styles.methodTabActive : ''}`}
          onClick={() => onMethodChange('wechat')}
        >
          微信
        </button>
        <button
          type="button"
          className={`${styles.methodTab} ${method === 'alipay' ? styles.methodTabActive : ''}`}
          onClick={() => onMethodChange('alipay')}
        >
          支付宝
        </button>
      </div>

      {/* 收款码：配置了就显示图，没配显示占位提示 */}
      <div className={styles.qrBox}>
        {qr ? (
          <img className={styles.qrImg} src={qr} alt="收款码" />
        ) : (
          <div className={styles.qrEmpty}>收款码未配置，请联系客服</div>
        )}
      </div>

      {order.payee_name && <p className={styles.payee}>收款人：{order.payee_name}</p>}
      <p className={styles.payHint}>请扫码支付 ¥{order.amount}，支付完成后点下方按钮。</p>

      {/* 付款备注（可选） */}
      <input
        className={styles.noteInput}
        type="text"
        value={payNote}
        onChange={(e) => onPayNoteChange(e.target.value)}
        placeholder="可填付款尾号/备注，便于核对（选填）"
        maxLength={50}
      />

      <button type="button" className={styles.claimBtn} disabled={claiming} onClick={onClaim}>
        {claiming ? (
          <>
            <Loader2 size={14} className={styles.spin} />
            提交中
          </>
        ) : (
          '我已支付'
        )}
      </button>
    </div>
  )
}

// ── 已支付·待审核视图 ──
function ReviewingView({ order }: { order: ReviewOrder }) {
  return (
    <div className={styles.review}>
      <Clock size={40} className={styles.reviewIcon} />
      <p className={styles.reviewTitle}>已收到你的支付，正在人工审核</p>
      <p className={styles.reviewDesc}>
        升级到 <b>{tierLabel(order.tier)}</b> 的订单已提交，核对到账后会自动为你升级，
        期间可关闭本窗口。
      </p>
      {order.contact && (
        <p className={styles.reviewContact}>如未及时到账，可联系：{order.contact}</p>
      )}
    </div>
  )
}

