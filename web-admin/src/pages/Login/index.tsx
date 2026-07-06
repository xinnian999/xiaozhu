import { useState } from 'react'
import { Card, Form, Input, Button, Typography, App as AntdApp } from 'antd'
import { useAuthStore } from '@/store/auth'
import styles from './index.module.scss'

// ============================================
// 管理员登录页
// ============================================
export default function Login() {
  const login = useAuthStore((s) => s.login)
  const [submitting, setSubmitting] = useState(false)
  const { message } = AntdApp.useApp()

  const handleSubmit = async (values: { email: string; password: string }) => {
    setSubmitting(true)
    try {
      await login(values.email, values.password)
    } catch {
      message.error('登录失败：账号密码错误，或该账号不是管理员')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.page}>
      <Card className={styles.card}>
        <Typography.Title level={3} className={styles.title}>
          小筑 管理后台
        </Typography.Title>
        <Form layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, message: '请输入邮箱' }]}>
            <Input autoComplete="email" placeholder="管理员邮箱" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" placeholder="密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
