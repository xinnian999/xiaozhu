import { Tooltip, Typography } from 'antd'

// ============================================
// 后台表格「用户」列的统一渲染：昵称 + 邮箱（小字），替代裸 user_id 展示。
// 昵称、邮箱都空时（匿名 / 用户已删）显示「—」。多个列表页共用，保持一致。
// ============================================
type Props = {
  nickname: string | null
  email: string | null
}

export default function UserCell({ nickname, email }: Props) {
  if (!nickname && !email) return <>—</>
  return (
    <Tooltip title={email || ''} placement="topLeft">
      <div style={{ lineHeight: 1.3 }}>
        <div>{nickname || '（无昵称）'}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {email || '—'}
        </Typography.Text>
      </div>
    </Tooltip>
  )
}
