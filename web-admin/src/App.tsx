import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router'
import { App as AntdApp, ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useAuthStore } from '@/store/auth'
import { useThemeStore } from '@/store/theme'
import Login from '@/pages/Login'
import AdminLayout from '@/components/Layout'
import Users from '@/pages/Users'
import Orders from '@/pages/Orders'
import Sessions from '@/pages/Sessions'
import EmailCodes from '@/pages/EmailCodes'
import Settings from '@/pages/Settings'
import Models from '@/pages/Models'

// ============================================
// 应用根组件：主题联动 + 登录态恢复 + 路由
// ============================================
export default function App() {
  const init = useAuthStore((s) => s.init)
  const ready = useAuthStore((s) => s.ready)
  const user = useAuthStore((s) => s.user)
  const theme = useThemeStore((s) => s.theme)

  // 首次挂载时把 html[data-theme] 同步成 store 里的初始值（localStorage 恢复的值）
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    init()
  }, [init])

  if (!ready) return null

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { colorPrimary: '#e11d48' },
      }}
    >
      <AntdApp>
        <BrowserRouter basename="/admin">
          <Routes>
            <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
            <Route
              path="/*"
              element={user ? <AdminLayout /> : <Navigate to="/login" replace />}
            >
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<Users />} />
              <Route path="orders" element={<Orders />} />
              <Route path="sessions" element={<Sessions />} />
              <Route path="email-codes" element={<EmailCodes />} />
              <Route path="settings" element={<Settings />} />
              <Route path="models" element={<Models />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  )
}
