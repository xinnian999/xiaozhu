import { useCallback, useEffect, useState } from 'react'
import { Table, Button, Popconfirm, Tag, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { listEmailCodes, countEmailCodes, deleteEmailCode, type AdminEmailCode } from '@/lib/api'

const PAGE_SIZE = 20

// ============================================
// 邮箱验证码页（对齐 admin.py 的 EmailCodeAdmin：只读 + 可删，排障用）
// ============================================
export default function EmailCodes() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminEmailCode[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [list, count] = await Promise.all([
        listEmailCodes({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        countEmailCodes(),
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

  const onDelete = async (email: string) => {
    await deleteEmailCode(email)
    message.success('已删除')
    fetchData()
  }

  const columns: ColumnsType<AdminEmailCode> = [
    { title: '邮箱', dataIndex: 'email', ellipsis: true },
    { title: '验证码', dataIndex: 'code' },
    { title: '尝试次数', dataIndex: 'attempts', width: 90 },
    {
      title: '过期时间',
      dataIndex: 'expires_at',
      render: (v: string) => {
        const expired = dayjs(v).isBefore(dayjs())
        return <Tag color={expired ? 'default' : 'green'}>{dayjs(v).format('MM-DD HH:mm')}</Tag>
      },
    },
    { title: '发送时间', dataIndex: 'sent_at', render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Popconfirm title="确认删除该记录？" onConfirm={() => onDelete(row.email)} okText="删除" cancelText="取消">
          <Button type="link" size="small" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <Table
      rowKey="email"
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
