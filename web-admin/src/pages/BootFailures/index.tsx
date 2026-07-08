import { useCallback, useEffect, useState } from 'react'
import { Table, Tag, Statistic, Card, Tooltip, Typography, Segmented, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import UserCell from '@/components/UserCell'
import {
  listBootFailures,
  countBootFailures,
  recentBootFailures,
  getBootStats,
  type AdminBootFailure,
  type BootStats,
} from '@/lib/api'

const PAGE_SIZE = 20

// ============================================
// 预览 boot 监控页（只读）
// WebContainer 运行环境从境外 boot，国内偶发失败/很慢。C 端前端每次 boot 结束都上报到
// boot_failures 表（成功 kind='ok' + 耗时，失败 timeout/error）。这里全量列出 + 支持按类型过滤，
// 顶部展示耗时统计与分布，用于监控失败率、定位偶发原因、判断是否被限速。
// ============================================

// 结果类型 → 展示颜色/文案（含成功）
const KIND_META: Record<string, { color: string; label: string }> = {
  ok: { color: 'green', label: '成功' },
  timeout: { color: 'orange', label: '超时' },
  error: { color: 'red', label: '异常' },
}

// 列表过滤选项：全部 / 只看失败 / 各单项。value 直接传给后端 kind 参数（'all' 映射成不传）。
const FILTER_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '失败', value: 'fail' },
  { label: '成功', value: 'ok' },
  { label: '超时', value: 'timeout' },
  { label: '异常', value: 'error' },
]

export default function BootFailures() {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<AdminBootFailure[]>([])
  const [total, setTotal] = useState(0)
  const [recent, setRecent] = useState(0)
  const [stats, setStats] = useState<BootStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  // 当前列表过滤（'all' = 全量含成功）。切换时回到第 1 页。
  const [filter, setFilter] = useState('all')

  const fetchData = useCallback(async () => {
    setLoading(true)
    // 'all' 不传 kind（全量）；其余把值透传给后端 kind 过滤。
    const kindParam = filter === 'all' ? undefined : filter
    try {
      const [list, count, recent24, bootStats] = await Promise.all([
        listBootFailures({ offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, kind: kindParam }),
        countBootFailures({ kind: kindParam }),
        recentBootFailures(24),
        getBootStats(),
      ])
      setData(list)
      setTotal(count)
      setRecent(recent24)
      setStats(bootStats)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [page, filter, message])

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
      title: '冷/热',
      dataIndex: 'cold',
      width: 80,
      // cold=true：会话内首次 boot（运行时/依赖都没缓存，最慢）；false：切项目热 boot。
      render: (v: boolean | null) =>
        v === null ? <Tag>未知</Tag> : v ? <Tag color="purple">冷</Tag> : <Tag color="cyan">热</Tag>,
    },
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
    {
      // 用户列：昵称 + 邮箱替代裸 user_id（裸 id 看了没意义）。都空时（匿名/用户已删）显示「—」。
      title: '用户',
      dataIndex: 'user_nickname',
      width: 200,
      ellipsis: true,
      render: (_: unknown, row: AdminBootFailure) => (
        <UserCell nickname={row.user_nickname} email={row.user_email} />
      ),
    },
  ]

  const fmtMs = (ms: number | null | undefined) =>
    ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  // 直方图里最大档的计数，用来算每根柱的相对宽度。
  const bucketMax = Math.max(1, ...(stats?.buckets.map((b) => b.count) ?? [0]))

  return (
    <div>
      {/* 顶部概览：失败数 + boot 成功耗时（总体/冷/热），一眼看出「多快、多慢、多频繁」 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="累计失败" value={total} />
        </Card>
        <Card size="small" style={{ minWidth: 150 }}>
          <Statistic title="近 24 小时失败" value={recent} valueStyle={recent > 0 ? { color: '#cf1322' } : undefined} />
        </Card>
        <Card size="small" style={{ minWidth: 180 }}>
          <Statistic
            title={`成功 boot 平均耗时（n=${stats?.success.count ?? 0}）`}
            value={stats?.success.avg_ms != null ? (stats.success.avg_ms / 1000).toFixed(1) : '—'}
            suffix={stats?.success.avg_ms != null ? 's' : ''}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最快 {fmtMs(stats?.success.min_ms)} / 最慢 {fmtMs(stats?.success.max_ms)}
          </Typography.Text>
        </Card>
        <Card size="small" style={{ minWidth: 160 }}>
          <Statistic
            title={`冷 boot 平均（n=${stats?.success_cold.count ?? 0}）`}
            value={stats?.success_cold.avg_ms != null ? (stats.success_cold.avg_ms / 1000).toFixed(1) : '—'}
            suffix={stats?.success_cold.avg_ms != null ? 's' : ''}
            valueStyle={{ color: '#722ed1' }}
          />
        </Card>
        <Card size="small" style={{ minWidth: 160 }}>
          <Statistic
            title={`热 boot 平均（n=${stats?.success_hot.count ?? 0}）`}
            value={stats?.success_hot.avg_ms != null ? (stats.success_hot.avg_ms / 1000).toFixed(1) : '—'}
            suffix={stats?.success_hot.avg_ms != null ? 's' : ''}
            valueStyle={{ color: '#08979c' }}
          />
        </Card>
      </div>

      {/* 成功 boot 耗时分布直方图：看慢样本是不是扎堆在某个档（如都卡 60-120s → 疑似固定限速）。 */}
      <Card size="small" title="成功 boot 耗时分布" style={{ marginBottom: 16 }}>
        {stats && stats.buckets.some((b) => b.count > 0) ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stats.buckets.map((b) => (
              <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 64, textAlign: 'right', fontSize: 12, color: '#888' }}>{b.label}</span>
                <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(b.count / bucketMax) * 100}%`,
                      minWidth: b.count > 0 ? 2 : 0,
                      height: 18,
                      background: '#1677ff',
                      borderRadius: 4,
                    }}
                  />
                </div>
                <span style={{ width: 48, fontSize: 12 }}>{b.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <Typography.Text type="secondary">暂无成功 boot 数据</Typography.Text>
        )}
      </Card>

      {/* 列表过滤器：全部（含成功）/ 失败 / 成功 / 超时 / 异常。切换回到第 1 页。 */}
      <div style={{ marginBottom: 12 }}>
        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={(v) => {
            setFilter(v as string)
            setPage(1)
          }}
        />
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
