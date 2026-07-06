import { useCallback, useEffect, useState } from 'react'
import { Table, Button, Drawer, Input, Space, Tag, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { listSettings, updateSetting, type AdminSetting } from '@/lib/api'
import styles from './index.module.scss'

// ============================================
// 应用配置页（对齐 admin.py 的 AppSettingAdmin：只改 value，敏感值脱敏）
// ============================================
export default function Settings() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminSetting[]>([])
  const [loading, setLoading] = useState(false)

  // 编辑弹窗
  const [editing, setEditing] = useState<AdminSetting | null>(null)
  const [value, setValue] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      setData(await listSettings())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // 打开编辑：敏感项列表里是脱敏值，编辑时清空、让管理员重填明文（不回填脱敏串）
  const openEdit = (row: AdminSetting) => {
    setEditing(row)
    setValue(row.is_secret ? '' : row.value)
  }

  const submitEdit = async () => {
    if (!editing) return
    await updateSetting(editing.key, value)
    message.success('已保存并刷新缓存')
    setEditing(null)
    fetchData()
  }

  const columns: ColumnsType<AdminSetting> = [
    { title: '分类', dataIndex: 'category', width: 100, render: (v: string) => <Tag>{v || '其他'}</Tag> },
    { title: '键', dataIndex: 'key', width: 180 },
    {
      title: '值',
      dataIndex: 'value',
      ellipsis: true,
      render: (v: string, row) =>
        row.is_secret ? <span className={styles.secret}>{v || '（未设置）'}</span> : v || '—',
    },
    { title: '说明', dataIndex: 'description', ellipsis: true },
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
    <>
      <Table
        rowKey="key"
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 'max-content' }}
        pagination={false}
      />

      <Drawer
        title={`编辑配置 · ${editing?.key ?? ''}`}
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
        <p className={styles.desc}>{editing?.description}</p>
        {editing?.is_secret ? (
          <Input.Password
            placeholder="敏感项，请重新输入明文新值（留空视为清空）"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <Input.TextArea
            autoSize={{ minRows: 1, maxRows: 6 }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Drawer>
    </>
  )
}
