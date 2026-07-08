import { useCallback, useEffect, useState } from 'react'
import { Table, Button, Popconfirm, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import UserCell from '@/components/UserCell'
import { listSessions, countSessions, deleteSession, type AdminSession } from '@/lib/api'

const PAGE_SIZE = 20

// ============================================
// 会话页（对齐 admin.py 的 SessionAdmin：只读 + 可删）
// ============================================
export default function Sessions() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminSession[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [list, count] = await Promise.all([
        listSessions({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        countSessions(),
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

  const onDelete = async (id: string) => {
    await deleteSession(id)
    message.success('已删除')
    fetchData()
  }

  const columns: ColumnsType<AdminSession> = [
    { title: '标题', dataIndex: 'title', ellipsis: true, render: (v: string | null) => v || '—' },
    {
      // 用户列：昵称 + 邮箱替代裸 user_id。
      title: '用户',
      dataIndex: 'user_nickname',
      width: 200,
      ellipsis: true,
      render: (_, row) => <UserCell nickname={row.user_nickname} email={row.user_email} />,
    },
    { title: '创建时间', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    { title: '更新时间', dataIndex: 'updated_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Popconfirm title="确认删除该会话？" onConfirm={() => onDelete(row.id)} okText="删除" cancelText="取消">
          <Button type="link" size="small" danger>
            删除
          </Button>
        </Popconfirm>
      ),
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
