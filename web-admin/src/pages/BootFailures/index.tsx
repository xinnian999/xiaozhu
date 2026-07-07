import { useCallback, useEffect, useState } from 'react'
import { Table, Tag, Statistic, Card, Tooltip, Typography, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import {
  listBootFailures,
  countBootFailures,
  recentBootFailures,
  type AdminBootFailure,
} from '@/lib/api'

const PAGE_SIZE = 20

// ============================================
// 预览 boot 失败监控页（只读）
// WebContainer 运行环境从境外 boot，国内偶发失败。C 端前端把失败上报到 boot_failures 表，
// 这里列出来 + 顶部展示「总数 / 近 24h」，用于监控失败率、定位偶发原因。
// ============================================

// 失败类型 → 展示颜色/文案
const KIND_META: Record<string, { color: string; label: string }> = {
  timeout: { color: 'orange', label: '超时' },
  error: { color: 'red', label: '异常' },
}

export default function BootFailures() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminBootFailure[]>([])
  const [total, setTotal] = useState(0)
  const [recent, setRecent] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [list, count, recent24] = await Promise.all([
        listBootFailures({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
        countBootFailures(),
        recentBootFailures(24),
      ])
      setData(list)
      setTotal(count)
      setRecent(recent24)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, message])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const columns: ColumnsType<AdminBootFailure> = [
    { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 80,
      render: (v: string) => {
        const m = KIND_META[v] ?? { color: 'default', label: v }
        return <Tag color={m.color}>{m.label}</Tag>
      },
    },
    { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: 'COOP/COEP',
      dataIndex: 'cross_origin_isolated',
      width: 100,
      // false = 跨域隔离没生效（SharedArrayBuffer 不可用），是 boot 必败的硬原因，标红醒目。
      render: (v: boolean | null) =>
        v === null ? <Tag>未知</Tag> : v ? <Tag color="green">已隔离</Tag> : <Tag color="red">未隔离</Tag>,
    },
    {
      title: '耗时',
      dataIndex: 'elapsed_ms',
      width: 90,
      render: (v: number | null) => (v == null ? '—' : `${(v / 1000).toFixed(1)}s`),
    },
    {
      title: '错误信息',
      dataIndex: 'message',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <Typography.Text style={{ maxWidth: 360 }} ellipsis>
            {v || '—'}
          </Typography.Text>
        </Tooltip>
      ),
    },
    { title: '用户 ID', dataIndex: 'user_id', width: 120, ellipsis: true, render: (v: string | null) => v || '—' },
    { title: '会话 ID', dataIndex: 'session_id', width: 120, ellipsis: true, render: (v: string | null) => v || '—' },
  ]

  return (
    <div>
      {/* 顶部概览：总失败数 + 近 24h，一眼看出失败率趋势 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <Card size="small" style={{ minWidth: 160 }}>
          <Statistic title="累计失败" value={total} />
        </Card>
        <Card size="small" style={{ minWidth: 160 }}>
          <Statistic title="近 24 小时" value={recent} valueStyle={recent > 0 ? { color: '#cf1322' } : undefined} />
        </Card>
      </div>

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
    </div>
  )
}
