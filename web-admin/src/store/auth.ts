import { create } from 'zustand'
import { getToken, setToken } from '@/lib/http'
import { login as apiLogin, getMe, checkIsAdmin, type ApiUser } from '@/lib/api'

// ============================================
// Auth store：管理员登录态（与主前端 web/src/store/auth.ts 模式一致）
// ============================================
// 登录复用现有 /api/users/login（同一套账号体系）。/api/users/me 只校验登录态，
// 不校验管理员身份，所以额外调 checkIsAdmin()（打一个受 get_current_admin 保护的
// 接口）—— 非管理员会 403，被 http.ts 的响应拦截器统一处理成清 token + 跳登录页。

type AuthState = {
  user: ApiUser | null
  ready: boolean
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,

  init: async () => {
    const token = getToken()
    if (!token) {
      set({ user: null, ready: true })
      return
    }
    try {
      const [user] = await Promise.all([getMe(), checkIsAdmin()])
      set({ user, ready: true })
    } catch {
      setToken(null)
      set({ user: null, ready: true })
    }
  },

  login: async (email, password) => {
    const token = await apiLogin(email, password)
    setToken(token)
    try {
      const [user] = await Promise.all([getMe(), checkIsAdmin()])
      set({ user })
    } catch (err) {
      setToken(null)
      throw err
    }
  },

  logout: () => {
    setToken(null)
    set({ user: null })
    window.location.href = '/admin/login'
  },
}))
