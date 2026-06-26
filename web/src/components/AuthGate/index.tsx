import { useState } from 'react'
import type { FormEvent } from 'react'
import { Mail, Lock, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import styles from './index.module.scss'

// ============================================
// 登录门：未登录时挡在主应用前面的登录 / 注册页
// ============================================
// 两种模式（登录 / 注册）共用一套表单，靠 mode 切换文案和提交逻辑。

type Mode = 'login' | 'register'

export default function AuthGate() {
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 表单内联错误（如"密码错误"），区别于全局 toast，就近显示在表单里
  const [error, setError] = useState<string | null>(null)

  const isLogin = mode === 'login'

  // 切换登录 / 注册：清空错误，保留已填的邮箱密码方便用户改完直接换模式提交
  const switchMode = () => {
    setMode(isLogin ? 'register' : 'login')
    setError(null)
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

    setSubmitting(true)
    try {
      if (isLogin) await login(email, password)
      else await register(email, password)
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
