import { useCallback, useEffect, useState } from 'react'
import {
  Table,
  Input,
  Button,
  Drawer,
  Form,
  Select,
  InputNumber,
  Switch,
  Space,
  Tag,
  App as AntdApp,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import {
  listUsers,
  countUsers,
  updateUser,
  grantTierBatch,
  type AdminUser,
} from '@/lib/api'
import styles from './index.module.scss'

const PAGE_SIZE = 20

// 档位对应的展示色，和 C 端习惯一致（free 灰 / pro 蓝 / max 金）
const TIER_COLOR: Record<string, string> = { free: 'default', pro: 'blue', max: 'gold' }

// ============================================
// 用户管理页（对齐 admin.py 的 UserAdmin）
// ============================================
export default function Users() {
  const { message } = AntdApp.useApp()

  const [data, setData] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  // 已选中的行 key（用于批量续费）
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // 编辑弹窗
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [form] = Form.useForm()

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = { q: q || undefined, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }
      const [list, count] = await Promise.all([listUsers(params), countUsers({ q: q || undefined })])
      setData(list)
      setTotal(count)
    } finally {
      setLoading(false)
    }
  }, [page, q])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // 打开编辑弹窗：把当前行数据灌进表单（日期字段转 dayjs）
  const openEdit = (user: AdminUser) => {
    setEditing(user)
    form.setFieldsValue({
      nickname: user.nickname,
      tier: user.tier,
      daily_used: user.daily_used,
      is_admin: user.is_admin,
    })
  }

  const submitEdit = async () => {
    if (!editing) return
    const values = await form.validateFields()
    try {
      await updateUser(editing.id, {
        nickname: values.nickname,
        tier: values.tier,
        daily_used: values.daily_used,
        is_admin: values.is_admin,
      })
      message.success('已保存')
      setEditing(null)
      fetchData()
    } catch {
      // http 拦截器已提示错误详情（如「改成付费档必须给未来到期时间」）
    }
  }

  // 批量续费/升级
  const doGrant = async (tier: 'pro' | 'max') => {
    if (selectedIds.length === 0) return
    try {
      await grantTierBatch(selectedIds, tier)
      message.success(`已为 ${selectedIds.length} 个用户续费到 ${tier === 'pro' ? 'Pro' : 'Max'}（30 天）`)
      setSelectedIds([])
      fetchData()
    } catch {
      /* 错误已全局提示 */
    }
  }

  const columns: ColumnsType<AdminUser> = [
    { title: '邮箱', dataIndex: 'email', ellipsis: true },
    { title: '昵称', dataIndex: 'nickname', ellipsis: true },
    {
      title: '档位',
      dataIndex: 'tier',
      render: (tier: string) => <Tag color={TIER_COLOR[tier] ?? 'default'}>{tier}</Tag>,
    },
    { title: '今日已用', dataIndex: 'daily_used', width: 90 },
    {
      title: '到期时间',
      dataIndex: 'tier_expires_at',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
    },
    {
      title: '管理员',
      dataIndex: 'is_admin',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="red">是</Tag> : '—'),
    },
    {
      title: '注册时间',
      dataIndex: 'created_at',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Button type="link" size="small" onClick={() => openEdit(row)}>
          编辑
        </Button>
      ),
    },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Input.Search
          placeholder="搜索邮箱 / 昵称"
          allowClear
          className={styles.search}
          onSearch={(v) => {
            setQ(v)
            setPage(1)
          }}
        />
        <Space>
          <Button disabled={selectedIds.length === 0} onClick={() => doGrant('pro')}>
            续费到 Pro（30天）
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => doGrant('max')}>
            续费到 Max（30天）
          </Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 'max-content' }}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />

      <Drawer
        title="编辑用户"
        open={!!editing}
        onClose={() => setEditing(null)}
        width={480}
        destroyOnHidden
        footer={
          <Space className={styles.drawerFooter}>
            <Button onClick={() => setEditing(null)}>取消</Button>
            <Button type="primary" onClick={submitEdit}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" className={styles.editForm}>
          <Form.Item label="昵称" name="nickname" rules={[{ required: true, message: '昵称不能为空' }]}>
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item
            label="档位"
            name="tier"
            extra="切换到付费档（pro/max）时，到期时间自动从今天起算 30 天；切回 free 会清空到期时间。"
          >
            <Select
              options={[
                { value: 'free', label: 'free' },
                { value: 'pro', label: 'pro' },
                { value: 'max', label: 'max' },
              ]}
            />
          </Form.Item>
          <Form.Item label="今日已用点数" name="daily_used">
            <InputNumber min={0} className={styles.fullWidth} />
          </Form.Item>
          <Form.Item label="管理员" name="is_admin" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}
