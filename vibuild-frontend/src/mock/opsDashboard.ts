import type { FileMap, Session, Version } from '@/types/project'
import { buildCommonBaseFiles, DAY, MIN, NOW } from './_shared'

// ============================================
// 项目 C：运营看板（多分支版本树）
// ============================================
// 版本树：
//   main:           v1 → v2 → v3 → v4
//   branch-charts:        ├── v2-charts → v3-charts
//   branch-dark-theme:    └── v3-dark   （从 v3 分出）

// ---------- 源码片段 ----------

const INDEX_CSS_LIGHT = `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif;
  background: #f8fafc;
  color: #0f172a;
}
`

const INDEX_CSS_DARK = `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif;
  background: #0f172a;
  color: #e2e8f0;
}
`

const APP_V1 = `export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700 }}>Ops Dashboard</h1>
      <p style={{ marginTop: 8, color: '#64748b' }}>运营数据看板（初始化）</p>
    </main>
  )
}
`

const APP_V2 = `import StatCards from './components/StatCards'

export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>Ops Dashboard</h1>
      <StatCards />
    </main>
  )
}
`

const STAT_CARDS = `const stats = [
  { label: 'DAU', value: '12,408', trend: '+8.2%' },
  { label: '订单量', value: '3,621', trend: '+3.5%' },
  { label: '客单价', value: '¥186', trend: '-1.1%' },
  { label: '退款率', value: '0.42%', trend: '-0.3%' },
]

export default function StatCards() {
  return (
    <div style={{
      display: 'grid', gap: 16,
      gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    }}>
      {stats.map((s) => (
        <article key={s.label} style={{
          background: 'white', borderRadius: 12, padding: 20,
          border: '1px solid #e2e8f0',
        }}>
          <p style={{ color: '#64748b', fontSize: 13 }}>{s.label}</p>
          <p style={{ marginTop: 8, fontSize: 28, fontWeight: 700 }}>{s.value}</p>
          <p style={{ marginTop: 4, fontSize: 12, color: s.trend.startsWith('+') ? '#16a34a' : '#dc2626' }}>{s.trend}</p>
        </article>
      ))}
    </div>
  )
}
`

const APP_V3 = `import StatCards from './components/StatCards'
import OrderTable from './components/OrderTable'

export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>Ops Dashboard</h1>
      <StatCards />
      <div style={{ marginTop: 32 }}>
        <OrderTable />
      </div>
    </main>
  )
}
`

const ORDER_TABLE = `const orders = [
  { id: 'O-2031', customer: '张明', amount: 268, status: '已发货' },
  { id: 'O-2030', customer: '李雯', amount: 419, status: '待付款' },
  { id: 'O-2029', customer: '王浩', amount: 89,  status: '已完成' },
  { id: 'O-2028', customer: '陈悦', amount: 552, status: '已退款' },
]

export default function OrderTable() {
  return (
    <section style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
      <h2 style={{ padding: '16px 20px', fontSize: 16, borderBottom: '1px solid #e2e8f0' }}>最近订单</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <th style={{ padding: '12px 20px', textAlign: 'left' }}>订单号</th>
            <th style={{ padding: '12px 20px', textAlign: 'left' }}>客户</th>
            <th style={{ padding: '12px 20px', textAlign: 'right' }}>金额</th>
            <th style={{ padding: '12px 20px', textAlign: 'left' }}>状态</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ padding: '12px 20px', fontFamily: 'monospace' }}>{o.id}</td>
              <td style={{ padding: '12px 20px' }}>{o.customer}</td>
              <td style={{ padding: '12px 20px', textAlign: 'right' }}>¥{o.amount}</td>
              <td style={{ padding: '12px 20px', color: '#64748b' }}>{o.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
`

const APP_V4 = `import StatCards from './components/StatCards'
import OrderTable from './components/OrderTable'
import Filters from './components/Filters'

export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 32, fontWeight: 700 }}>Ops Dashboard</h1>
        <Filters />
      </header>
      <StatCards />
      <div style={{ marginTop: 32 }}>
        <OrderTable />
      </div>
    </main>
  )
}
`

const FILTERS = `export default function Filters() {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {['今日', '近 7 天', '近 30 天'].map((t, i) => (
        <button key={t} style={{
          padding: '8px 14px', borderRadius: 8, fontSize: 13,
          background: i === 1 ? '#0f172a' : 'white',
          color: i === 1 ? 'white' : '#0f172a',
          border: '1px solid #e2e8f0', cursor: 'pointer',
        }}>{t}</button>
      ))}
    </div>
  )
}
`

// —— 分支 1：从 v2 分出，把指标卡换成图表
const APP_V2_CHARTS = `import ChartGrid from './components/ChartGrid'

export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>Ops Dashboard</h1>
      <ChartGrid />
    </main>
  )
}
`

const CHART_GRID = `// 简单的 SVG 折线图占位
const series = [12, 18, 15, 22, 30, 27, 35]

export default function ChartGrid() {
  const max = Math.max(...series)
  const points = series.map((v, i) =>
    \`\${(i / (series.length - 1)) * 100},\${100 - (v / max) * 100}\`
  ).join(' ')
  return (
    <section style={{ background: 'white', borderRadius: 12, padding: 24, border: '1px solid #e2e8f0' }}>
      <p style={{ color: '#64748b', fontSize: 13 }}>近 7 日 DAU 趋势</p>
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: 200, marginTop: 12 }}>
        <polyline points={points} fill="none" stroke="#6366f1" strokeWidth="2" />
      </svg>
    </section>
  )
}
`

const APP_V3_CHARTS = `import ChartGrid from './components/ChartGrid'
import StatCards from './components/StatCards'

export default function App() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 24 }}>Ops Dashboard</h1>
      <StatCards />
      <div style={{ marginTop: 24 }}><ChartGrid /></div>
    </main>
  )
}
`

// ---------- 文件集合 ----------

const BASE_FILES: FileMap = {
  ...buildCommonBaseFiles({ pkgName: 'ops-dashboard', htmlTitle: 'Ops Dashboard' }),
  'src/index.css': INDEX_CSS_LIGHT,
  'src/App.tsx': APP_V1,
}

// ---------- 版本（主线） ----------

const v1: Version = {
  id: 'v1',
  label: '初始化看板',
  summary: '空白看板骨架',
  branchId: 'main',
  createdAt: NOW - 7 * DAY,
  diff: { added: 180, removed: 0 },
  authorRole: 'assistant',
  files: BASE_FILES,
}

const v2: Version = {
  id: 'v2',
  label: '加 4 个指标卡',
  summary: '增加 DAU / 订单量 / 客单价 / 退款率四张卡片',
  branchId: 'main',
  parentVersionId: 'v1',
  createdAt: NOW - 6 * DAY,
  diff: { added: 64, removed: 6 },
  authorRole: 'assistant',
  files: {
    ...BASE_FILES,
    'src/App.tsx': APP_V2,
    'src/components/StatCards.tsx': STAT_CARDS,
  },
}

const v3: Version = {
  id: 'v3',
  label: '加订单列表',
  summary: '在指标卡下方追加最近订单表格',
  branchId: 'main',
  parentVersionId: 'v2',
  createdAt: NOW - 5 * DAY,
  diff: { added: 78, removed: 4 },
  authorRole: 'assistant',
  files: {
    ...v2.files,
    'src/App.tsx': APP_V3,
    'src/components/OrderTable.tsx': ORDER_TABLE,
  },
}

const v4: Version = {
  id: 'v4',
  label: '加时间筛选',
  summary: '在标题右侧加上时间段切换按钮',
  branchId: 'main',
  parentVersionId: 'v3',
  createdAt: NOW - 4 * DAY,
  diff: { added: 42, removed: 4 },
  authorRole: 'assistant',
  files: {
    ...v3.files,
    'src/App.tsx': APP_V4,
    'src/components/Filters.tsx': FILTERS,
  },
}

// ---------- 版本（分支 1：branch-charts） ----------

const v2Charts: Version = {
  id: 'v2-charts',
  label: '改为图表展示',
  summary: '把指标卡替换为折线图',
  branchId: 'branch-charts',
  parentVersionId: 'v2',
  createdAt: NOW - 5.5 * DAY,
  diff: { added: 52, removed: 22 },
  authorRole: 'assistant',
  files: {
    ...v2.files,
    'src/App.tsx': APP_V2_CHARTS,
    'src/components/ChartGrid.tsx': CHART_GRID,
  },
}

const v3Charts: Version = {
  id: 'v3-charts',
  label: '图表 + 指标卡',
  summary: '保留图表的同时把指标卡也加回来',
  branchId: 'branch-charts',
  parentVersionId: 'v2-charts',
  createdAt: NOW - 5 * DAY,
  diff: { added: 28, removed: 6 },
  authorRole: 'assistant',
  files: {
    ...v2Charts.files,
    'src/App.tsx': APP_V3_CHARTS,
  },
}

// ---------- 版本（分支 2：branch-dark-theme） ----------

const v3Dark: Version = {
  id: 'v3-dark',
  label: '暗色主题尝试',
  summary: '把整个看板切换到暗色主题',
  branchId: 'branch-dark-theme',
  parentVersionId: 'v3',
  createdAt: NOW - 4.5 * DAY,
  diff: { added: 14, removed: 14 },
  authorRole: 'assistant',
  files: {
    ...v3.files,
    'src/index.css': INDEX_CSS_DARK,
  },
}

// ---------- 导出 ----------

export const opsDashboard: Session = {
  id: 'ops-dashboard',
  name: '运营看板',
  description: '多分支版本树 · 指标卡 / 表格 / 筛选 / 图表',
  currentVersionId: 'v4',
  createdAt: v1.createdAt,
  updatedAt: v4.createdAt,
  versions: [v1, v2, v3, v4, v2Charts, v3Charts, v3Dark],
  messages: [
    {
      id: 'c-m1', role: 'user', branchId: 'main',
      text: '帮我搭一个运营数据看板，浅色主题，先有骨架就行',
      ts: v1.createdAt - MIN,
    },
    {
      id: 'c-m2', role: 'assistant', branchId: 'main',
      text: '已初始化空白看板，浅色背景 + slate 配色，方便后续加内容。',
      producedVersionId: 'v1', ts: v1.createdAt,
    },
    {
      id: 'c-m3', role: 'user', branchId: 'main',
      text: '加 4 个核心指标卡：DAU、订单量、客单价、退款率',
      ts: v2.createdAt - MIN,
    },
    {
      id: 'c-m4', role: 'assistant', branchId: 'main',
      text: '已加上 4 张响应式指标卡，含趋势涨跌色。',
      producedVersionId: 'v2', ts: v2.createdAt,
    },
    {
      id: 'c-m5', role: 'user', branchId: 'main',
      text: '下面追加一个最近订单的表格',
      ts: v3.createdAt - MIN,
    },
    {
      id: 'c-m6', role: 'assistant', branchId: 'main',
      text: '已新增订单列表，含订单号 / 客户 / 金额 / 状态四列。',
      producedVersionId: 'v3', ts: v3.createdAt,
    },
    {
      id: 'c-m7', role: 'user', branchId: 'main',
      text: '标题右边加一个时间段筛选',
      ts: v4.createdAt - MIN,
    },
    {
      id: 'c-m8', role: 'assistant', branchId: 'main',
      text: '已加上"今日 / 近 7 天 / 近 30 天"三段筛选按钮。',
      producedVersionId: 'v4', ts: v4.createdAt,
    },
    // 分支 1：图表实验
    {
      id: 'c-m3b', role: 'user', branchId: 'branch-charts',
      text: '回到指标卡这一版试试——把卡片换成趋势折线图会不会更直观？',
      ts: v2Charts.createdAt - MIN,
    },
    {
      id: 'c-m4b', role: 'assistant', branchId: 'branch-charts',
      text: '已在新分支替换为 SVG 折线图组件，先看效果。',
      producedVersionId: 'v2-charts', ts: v2Charts.createdAt,
    },
    {
      id: 'c-m5b', role: 'user', branchId: 'branch-charts',
      text: '把指标卡也加回来，图表 + 卡片一起呈现',
      ts: v3Charts.createdAt - MIN,
    },
    {
      id: 'c-m6b', role: 'assistant', branchId: 'branch-charts',
      text: '已恢复指标卡，置于图表上方。',
      producedVersionId: 'v3-charts', ts: v3Charts.createdAt,
    },
    // 分支 2：暗色实验（从主线 v3 分出）
    {
      id: 'c-m7c', role: 'user', branchId: 'branch-dark-theme',
      text: '试试把整个看板改成暗色主题，看 OPS 同学晚上值班是不是更舒服',
      ts: v3Dark.createdAt - MIN,
    },
    {
      id: 'c-m8c', role: 'assistant', branchId: 'branch-dark-theme',
      text: '已切换到 slate-900 暗色背景，文字配亮 slate 色。',
      producedVersionId: 'v3-dark', ts: v3Dark.createdAt,
    },
  ],
}
