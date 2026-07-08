import { useCallback, useEffect, useState } from 'react'
import { Table, Tag, Button, Space, Popconfirm, Input, Select, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import UserCell from '@/components/UserCell'
import {
  listOrders,
  countOrders,
  approveOrder,
  rejectOrder,
  type AdminOrder,
} from '@/lib/api'

const PAGE_SIZE = 20

// 状态 → Tag 配色 + 中文名
const STATUS_META: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待支付' },
  pending_review: { color: 'orange', label: '待审核' },
  paid: { color: 'green', label: '已通过' },
  rejected: { color: 'red', label: '已驳回' },
}

// 支付方式中文名
const METHOD_LABEL: Record<string, string> = { wechat: '微信', alipay: '支付宝' }

// ============================================
// 订单页：列表只读 + 待审核订单的「通过 / 驳回」人工审核
// ============================================
export default function Orders() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  // 状态筛选（默认全部）
  const [status, setStatus] = useState<string | undefined>(undefined)
  // 正在审核的订单 id（按钮 loading）
  const [acting, setActing] = useState<string | null>(null)
  // 驳回理由输入（按订单 id 暂存）
  const [rejectReason, setRejectReason] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [list, count] = await Promise.all([
        listOrders({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, status }),
        countOrders({ status }),
      ])
      setData(list)
      setTotal(count)
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const handleApprove = async (id: string) => {
    setActing(id)
    try {
      await approveOrder(id)
      message.success('已通过，用户已升档')
      fetchData()
    } finally {
      setActing(null)
    }
  }

  const handleReject = async (id: string) => {
    setActing(id)
    try {
      await rejectOrder(id, rejectReason.trim() || undefined)
      message.success('已驳回')
      setRejectReason('')
      fetchData()
    } finally {
      setActing(null)
    }
  }

  const columns: ColumnsType<AdminOrder> = [
    {
      // 用户列：昵称 + 邮箱替代裸 user_id。
      title: '用户',
      dataIndex: 'user_nickname',
      width: 200,
      ellipsis: true,
      render: (_, row) => <UserCell nickname={row.user_nickname} email={row.user_email} />,
    },
    { title: '档位', dataIndex: 'tier' },
    { title: '金额', dataIndex: 'amount', render: (v: string) => `¥${v}` },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string) => {
        const m = STATUS_META[v] ?? { color: 'default', label: v }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    {
      title: '支付方式',
      dataIndex: 'payment_method',
      render: (v: string | null) => (v ? METHOD_LABEL[v] ?? v : '—'),
    },
    { title: '付款备注', dataIndex: 'pay_note', ellipsis: true, render: (v: string | null) => v || '—' },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '支付时间',
      dataIndex: 'paid_at',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
    },
    {
      title: '操作',
      fixed: 'right',
      width: 160,
      render: (_, row) =>
        row.status === 'pending_review' ? (
          <Space>
            <Popconfirm
              title="确认已核对到账？"
              description="通过后将立即为该用户升档"
              onConfirm={() => handleApprove(row.id)}
              okText="通过"
              cancelText="取消"
            >
              <Button type="link" size="small" loading={acting === row.id}>
                通过
              </Button>
            </Popconfirm>
            <Popconfirm
              title="驳回该订单？"
              description={
                <Input
                  placeholder="驳回理由（选填）"
                  onChange={(e) => setRejectReason(e.target.value)}
                  style={{ width: 200 }}
                />
              }
              onConfirm={() => handleReject(row.id)}
              okText="驳回"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button type="link" size="small" danger loading={acting === row.id}>
                驳回
              </Button>
            </Popconfirm>
          </Space>
        ) : row.status === 'rejected' && row.reject_reason ? (
          <span style={{ color: '#999', fontSize: 12 }}>{row.reject_reason}</span>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <>
      <Space style={{ marginBottom: 16 }}>
        <span>状态筛选：</span>
        <Select
          allowClear
          placeholder="全部"
          style={{ width: 140 }}
          value={status}
          onChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={[
            { value: 'pending_review', label: '待审核' },
            { value: 'paid', label: '已通过' },
            { value: 'rejected', label: '已驳回' },
            { value: 'pending', label: '待支付' },
          ]}
        />
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />
    </>
  )
}
