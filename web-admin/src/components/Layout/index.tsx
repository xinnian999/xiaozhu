import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { Layout, Menu, Button, Tooltip } from 'antd'
import {
  Users as UsersIcon,
  Receipt,
  MessagesSquare,
  Mail,
  Settings as SettingsIcon,
  Bot,
  Activity,
  Sun,
  Moon,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { useThemeStore } from '@/store/theme'
import Avatar from '@/components/Avatar'
import styles from './index.module.scss'

const { Sider, Content } = Layout

// ============================================
// 管理后台整体布局：左侧导航 + 顶部栏 + 内容区
// ============================================
const MENU_ITEMS = [
  { key: 'users', label: '用户管理', icon: <UsersIcon size={16} /> },
  { key: 'orders', label: '订单', icon: <Receipt size={16} /> },
  { key: 'sessions', label: '会话', icon: <MessagesSquare size={16} /> },
  { key: 'boot-failures', label: '预览监控', icon: <Activity size={16} /> },
  { key: 'email-codes', label: '邮箱验证码', icon: <Mail size={16} /> },
  { key: 'settings', label: '应用配置', icon: <SettingsIcon size={16} /> },
  { key: 'models', label: 'LLM 模型', icon: <Bot size={16} /> },
]

export default function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)

  // 移动端：侧边栏默认收起，靠顶部按钮呼出（antd 的 collapsed + 抽屉式体验）
  const [collapsed, setCollapsed] = useState(window.innerWidth < 768)

  const activeKey = location.pathname.split('/').filter(Boolean)[0] ?? 'users'

  return (
    <Layout className={styles.layout}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        breakpoint="lg"
        theme={theme === 'dark' ? 'dark' : 'light'}
        className={styles.sider}
      >
        <div className={styles.brand}>{collapsed ? '小筑' : '小筑 · 管理后台'}</div>
        <Menu
          className={styles.menu}
          mode="inline"
          theme={theme === 'dark' ? 'dark' : 'light'}
          selectedKeys={[activeKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(`/${key}`)}
        />

        {/* 侧边栏底部：用户信息 + 主题切换 + 退出（顶栏已移除，功能下沉到这里） */}
        <div className={`${styles.siderFooter} ${collapsed ? styles.footerCollapsed : ''}`}>
          {user && (
            <div className={styles.userInfo}>
              <Avatar seed={user.avatar} size={28} title={user.nickname} />
              {!collapsed && (
                <span className={styles.userName}>{user.nickname ?? user.email}</span>
              )}
            </div>
          )}
          <div className={styles.footerActions}>
            <Tooltip title={collapsed ? (theme === 'dark' ? '浅色主题' : '深色主题') : ''} placement="top">
              <Button
                className={styles.footerBtn}
                type="text"
                icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                onClick={toggleTheme}
              >
                {!collapsed && (theme === 'dark' ? '浅色' : '深色')}
              </Button>
            </Tooltip>
            <Tooltip title={collapsed ? '退出登录' : ''} placement="top">
              <Button
                className={styles.footerBtn}
                type="text"
                icon={<LogOut size={16} />}
                onClick={logout}
              >
                {!collapsed && '退出'}
              </Button>
            </Tooltip>
            <Tooltip title={collapsed ? '展开侧栏' : ''} placement="top">
              <Button
                className={styles.footerBtn}
                type="text"
                icon={collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
                onClick={() => setCollapsed(!collapsed)}
              >
                {!collapsed && '收起'}
              </Button>
            </Tooltip>
          </div>
        </div>
      </Sider>
      <Layout>
        <Content className={styles.content}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
