import { create } from 'zustand'
import {
  getToken,
  setToken,
  login as apiLogin,
  register as apiRegister,
  getMe,
  updateProfile as apiUpdateProfile,
  type ApiUser,
  type ProfileUpdate,
} from '@/lib/api'

// ============================================
// Auth store：登录态管理（token + 当前用户）
// ============================================
// token 存在 localStorage（见 lib/api.ts 的 getToken/setToken），
// 这里只在内存里维护"当前用户对象"和"是否已完成首次登录态恢复"。

type AuthState = {
  // 当前登录用户；null 表示未登录
  user: ApiUser | null
  // 是否已完成首次"恢复登录态"的检查。
  // 用途：App 首屏在 ready 之前先显示加载占位，避免"已登录却闪一下登录页"。
  ready: boolean

  /** 应用启动时调用：若本地有 token，就用它拉一次 /me 校验，有效则恢复登录态。 */
  init: () => Promise<void>
  /** 登录：换 token → 存起来 → 拉用户信息。失败抛错由调用方（登录页）提示。 */
  login: (email: string, password: string) => Promise<void>
  /** 注册：带邮箱验证码建账号后自动登录（后端注册不返回 token，需再登录一次）。 */
  register: (email: string, password: string, code: string) => Promise<void>
  /** 登出：清 token + 用户，并刷新回首屏，确保不残留上一个用户的会话数据。 */
  logout: () => void
  /** 修改资料（昵称 / 头像）：提交后端并同步更新本地 user。 */
  updateProfile: (payload: ProfileUpdate) => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,

  init: async () => {
    const token = getToken()
    if (!token) {
      // 本地没 token，直接判定未登录、结束恢复
      set({ user: null, ready: true })
      return
    }
    try {
      // 有 token：拉 /me 验证它是否仍有效（可能已过期/被改）
      const user = await getMe()
      set({ user, ready: true })
    } catch {
      // token 失效：清掉，回到未登录态（/me 在静默名单里，不会触发自动跳转）
      setToken(null)
      set({ user: null, ready: true })
    }
  },

  login: async (email, password) => {
    const token = await apiLogin(email, password)
    setToken(token) // 先存 token，后续 getMe 的请求拦截器才能带上它
    const user = await getMe()
    set({ user })
  },

  register: async (email, password, code) => {
    await apiRegister(email, password, code)
    // 注册成功后直接复用登录逻辑拿 token（避免让用户再手动登一次）
    const token = await apiLogin(email, password)
    setToken(token)
    const user = await getMe()
    set({ user })
  },

  logout: () => {
    setToken(null)
    set({ user: null })
    // 整页刷新回首屏：最简单可靠地清空内存里上一个用户的会话/文件等状态，
    // 杜绝跨用户数据残留在 UI 上。
    window.location.href = '/'
  },

  updateProfile: async (payload) => {
    const user = await apiUpdateProfile(payload)
    set({ user })
  },
}))
