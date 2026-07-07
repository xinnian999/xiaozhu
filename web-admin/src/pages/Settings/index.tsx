import { useCallback, useEffect, useState } from 'react'
import { Table, Button, Drawer, Input, Space, Tag, Upload, App as AntdApp } from 'antd'
import { Upload as UploadIcon } from 'lucide-react'
import type { ColumnsType } from 'antd/es/table'
import type { UploadFile } from 'antd'
import { listSettings, updateSetting, type AdminSetting } from '@/lib/api'
import styles from './index.module.scss'

// 收款码这类「值是图片」的配置键：编辑时用图片上传控件，存 data URI。
const IMAGE_KEYS = new Set(['pay_qr_wechat', 'pay_qr_alipay'])

// 把文件读成 data URI（base64）
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// ============================================
// 应用配置页（对齐 admin.py 的 AppSettingAdmin：只改 value，敏感值脱敏）
// 收款码（pay_qr_*）用图片上传，其余用文本框
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

  // 图片上传：转 data URI 存进 value，拦截默认上传行为
  const handleUpload = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error('请上传图片文件')
      return Upload.LIST_IGNORE
    }
    // 收款码图片建议 <500KB，避免 app_settings 行过大
    if (file.size > 500 * 1024) {
      message.warning('图片较大（建议 <500KB），已接受但请尽量压缩')
    }
    try {
      setValue(await fileToDataUri(file))
      message.success('图片已就绪，点保存生效')
    } catch {
      message.error('图片读取失败')
    }
    return false // 阻止 antd 自动上传
  }

  const isImageEditing = editing ? IMAGE_KEYS.has(editing.key) : false

  const columns: ColumnsType<AdminSetting> = [
    { title: '分类', dataIndex: 'category', width: 100, render: (v: string) => <Tag>{v || '其他'}</Tag> },
    { title: '键', dataIndex: 'key', width: 180 },
    {
      title: '值',
      dataIndex: 'value',
      ellipsis: true,
      render: (v: string, row) => {
        // 收款码：列表里显示缩略图
        if (IMAGE_KEYS.has(row.key)) {
          return v ? (
            <img src={v} alt="收款码" style={{ height: 40, borderRadius: 4 }} />
          ) : (
            '（未设置）'
          )
        }
        return row.is_secret ? (
          <span className={styles.secret}>{v || '（未设置）'}</span>
        ) : (
          v || '—'
        )
      },
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
        {isImageEditing ? (
          // 收款码：图片上传 + 预览
          <Space direction="vertical" style={{ width: '100%' }}>
            {value && (
              <img
                src={value}
                alt="收款码预览"
                style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8 }}
              />
            )}
            <Upload
              accept="image/*"
              maxCount={1}
              showUploadList={false}
              beforeUpload={handleUpload as (file: UploadFile) => boolean | typeof Upload.LIST_IGNORE}
            >
              <Button icon={<UploadIcon size={14} />}>选择收款码图片</Button>
            </Upload>
          </Space>
        ) : editing?.is_secret ? (
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
