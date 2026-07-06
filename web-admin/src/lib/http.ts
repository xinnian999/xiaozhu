// ============================================
// API 客户端：axios 实例（与主前端 web/src/lib/api.ts 的 token 拦截思路一致）
// ============================================

import axios from 'axios'
import { message } from 'antd'

// token 存独立的 localStorage key，与主前端(C端)的 token 互不影响，
// 即便同一浏览器同时登录 C 端账号和管理员账号也不会串。
const TOKEN_KEY = 'xiaozhu-admin:token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

// 登录接口本身的 401（密码错）由登录页就近处理，不做全局跳转
const SILENT_PATHS = ['/api/users/login']

export const http = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
  timeout: 10_000,
})

http.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

http.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    const url: string = err.config?.url ?? ''
    const isSilent = SILENT_PATHS.some((p) => url.includes(p))

    // token 失效/过期，或不是管理员（403）：清 token 并回登录页
    if ((status === 401 || status === 403) && !isSilent) {
      setToken(null)
      message.error(status === 403 ? '无管理员权限' : '登录已过期，请重新登录')
      window.location.href = '/admin-app/login'
      return Promise.reject(new Error('未授权'))
    }

    const detail = err.response?.data?.detail ?? err.message
    message.error(typeof detail === 'string' ? detail : '请求失败')
    return Promise.reject(new Error(typeof detail === 'string' ? detail : '请求失败'))
  },
)
