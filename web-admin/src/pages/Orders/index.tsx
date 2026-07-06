import { useCallback, useEffect, useState } from 'react'
import { Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { listOrders, countOrders, type AdminOrder } from '@/lib/api'

const PAGE_SIZE = 20

// ============================================
// 订单页（对齐 admin.py 的 OrderAdmin：只读）
// ============================================
export default function Orders() {
  const [data, setData] = useState<AdminOrder[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [list, count] = await Promise.all([
        listOrders({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        countOrders(),
      ])
      setData(list)
      setTotal(count)
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const columns: ColumnsType<AdminOrder> = [
    { title: '订单号', dataIndex: 'id', ellipsis: true },
    { title: '用户 ID', dataIndex: 'user_id', ellipsis: true },
    { title: '档位', dataIndex: 'tier' },
    { title: '金额', dataIndex: 'amount', render: (v: string) => `¥${v}` },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string) => <Tag color={v === 'paid' ? 'green' : 'orange'}>{v}</Tag>,
    },
    { title: '创建时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '支付时间',
      dataIndex: 'paid_at',
      render: (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—'),
    },
  ]

  return (
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
  )
}
