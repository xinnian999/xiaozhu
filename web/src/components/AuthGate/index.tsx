import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Mail, Lock, KeyRound, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { sendCode } from '@/lib/api'
import styles from './index.module.scss'

// ============================================
// 登录门：未登录时挡在主应用前面的登录 / 注册页
// ============================================
// 两种模式（登录 / 注册）共用一套表单，靠 mode 切换文案和提交逻辑。
// 注册模式多一步「邮箱验证码」：必须先发码、验码通过才建号 —— 保证一个真实邮箱一个号。

type Mode = 'login' | 'register'

export default function AuthGate() {
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 验证码发送中
  const [sendingCode, setSendingCode] = useState(false)
  // 重发倒计时（秒）：>0 时「发送验证码」按钮置灰显示倒计时，防止狂点刷邮件
  const [countdown, setCountdown] = useState(0)
  // 表单内联错误（如"密码错误"），区别于全局 toast，就近显示在表单里
  const [error, setError] = useState<string | null>(null)

  const isLogin = mode === 'login'

  // 倒计时：countdown>0 时每秒减一，到 0 自动停（按钮恢复可点）
  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  // 切换登录 / 注册：清空错误，保留已填的邮箱密码方便用户改完直接换模式提交
  const switchMode = () => {
    setMode(isLogin ? 'register' : 'login')
    setError(null)
  }

  // 点「发送验证码」：校验邮箱 → 调后端发码 → 进入 60 秒倒计时
  const handleSendCode = async () => {
    if (sendingCode || countdown > 0) return
    if (!email) {
      setError('请先填写邮箱')
      return
    }
    setError(null)
    setSendingCode(true)
    try {
      await sendCode(email)
      setCountdown(60) // 后端限频 60s，前端同步倒计时，体验一致
    } catch (err) {
      // send-code 在静默名单里，错误（如"已注册"/"过于频繁"）不会全局 toast，这里就近提示
      setError(err instanceof Error ? err.message : '验证码发送失败')
    } finally {
      setSendingCode(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setError(null)

    // 前端先做一层基础校验，和后端规则对齐（密码至少 6 位），体验更即时
    if (password.length < 6) {
      setError('密码至少 6 位')
      return
    }
    // 注册必须填验证码
    if (!isLogin && !code.trim()) {
      setError('请填写邮箱验证码')
      return
    }

    setSubmitting(true)
    try {
      if (isLogin) await login(email, password)
      else await register(email, password, code.trim())
      // 成功后无需手动跳转：authStore.user 变为非空，App 会自动渲染主应用
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.gate}>
      <form className={styles.card} onSubmit={handleSubmit}>
        {/* 品牌位 */}
        <div className={styles.brand}>
          <img className={styles.brandMark} src="/logo.png" alt="小筑" />
          <span className={styles.brandText}>小筑</span>
        </div>

        <h1 className={styles.title}>{isLogin ? '登录' : '创建账号'}</h1>
        <p className={styles.subtitle}>
          {isLogin ? '欢迎回来，继续你的项目' : '注册一个账号，开始用 AI 生成应用'}
        </p>

        {/* 邮箱 */}
        <label className={styles.field}>
          <Mail size={16} className={styles.fieldIcon} />
          <input
            type="email"
            className={styles.input}
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>

        {/* 密码 */}
        <label className={styles.field}>
          <Lock size={16} className={styles.fieldIcon} />
          <input
            type="password"
            className={styles.input}
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
          />
        </label>

        {/* 邮箱验证码（仅注册）：输入框 + 右侧发送按钮 */}
        {!isLogin && (
          <label className={styles.field}>
            <KeyRound size={16} className={styles.fieldIcon} />
            <input
              type="text"
              inputMode="numeric"
              className={styles.input}
              placeholder="邮箱验证码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              required
            />
            <button
              type="button"
              className={styles.sendCodeBtn}
              onClick={handleSendCode}
              disabled={sendingCode || countdown > 0}
            >
              {countdown > 0 ? `${countdown}s` : sendingCode ? '发送中…' : '发送验证码'}
            </button>
          </label>
        )}

        {/* 内联错误 */}
        {error && <div className={styles.error}>{error}</div>}

        {/* 提交 */}
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? (
            <Loader2 size={16} className={styles.spin} />
          ) : (
            isLogin ? '登录' : '注册并登录'
          )}
        </button>

        {/* 切换模式 */}
        <div className={styles.switch}>
          {isLogin ? '还没有账号？' : '已有账号？'}
          <button type="button" className={styles.switchBtn} onClick={switchMode}>
            {isLogin ? '去注册' : '去登录'}
          </button>
        </div>
      </form>
    </div>
  )
}
