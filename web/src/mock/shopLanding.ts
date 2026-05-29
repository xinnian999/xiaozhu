import type { FileMap, Session, Version } from "@/types/project";
import { buildCommonBaseFiles, DAY, HOUR, MIN, NOW } from "./_shared";

// ============================================
// 项目 B：电商落地页（纯主线，无分支）
// ============================================
// 版本树：v1 → v2 → v3 → v3-checkpoint（用户手动 checkpoint）

// ---------- 源码片段 ----------

const INDEX_CSS = `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif;
  background: #fafafa;
  color: #111;
}
`;

const APP_V1 = `export default function App() {
  return (
    <main style={{ minHeight: '100vh', padding: '80px 8vw' }}>
      <h1 style={{ fontSize: 64, fontWeight: 700 }}>Lumie Store</h1>
      <p style={{ marginTop: 16, color: '#666' }}>正在筹备中，敬请期待。</p>
    </main>
  )
}
`;

const APP_V2 = `import Banner from './components/Banner'

export default function App() {
  return (
    <main>
      <Banner />
    </main>
  )
}
`;

const BANNER = `export default function Banner() {
  return (
    <section style={{
      minHeight: '70vh',
      background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '0 8vw',
    }}>
      <h1 style={{ fontSize: 72, fontWeight: 800, color: '#78350f' }}>夏日新品 30% OFF</h1>
      <p style={{ marginTop: 16, fontSize: 20, color: '#92400e' }}>限时三天，错过等明年</p>
      <button style={{
        marginTop: 36, width: 'fit-content',
        padding: '14px 32px', background: '#78350f', color: 'white',
        border: 0, borderRadius: 999, fontSize: 16, cursor: 'pointer',
      }}>立即抢购 →</button>
    </section>
  )
}
`;

const APP_V3 = `import Banner from './components/Banner'
import ProductGrid from './components/ProductGrid'

export default function App() {
  return (
    <main>
      <Banner />
      <ProductGrid />
    </main>
  )
}
`;

const PRODUCT_GRID = `const products = [
  { name: '亚麻衬衫', price: 199, img: '🧺' },
  { name: '草编凉鞋', price: 129, img: '👡' },
  { name: '宽檐草帽', price: 89, img: '👒' },
  { name: '帆布托特', price: 169, img: '👜' },
]

export default function ProductGrid() {
  return (
    <section style={{ padding: '80px 8vw' }}>
      <h2 style={{ fontSize: 36, marginBottom: 32 }}>热卖商品</h2>
      <div style={{
        display: 'grid', gap: 24,
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      }}>
        {products.map((p) => (
          <article key={p.name} style={{
            background: 'white', borderRadius: 16, padding: 24,
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}>
            <div style={{ fontSize: 64, textAlign: 'center' }}>{p.img}</div>
            <h3 style={{ marginTop: 12, fontSize: 16 }}>{p.name}</h3>
            <p style={{ marginTop: 8, color: '#dc2626', fontWeight: 600 }}>¥{p.price}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
`;

// ---------- 文件集合 ----------

const BASE_FILES: FileMap = {
  ...buildCommonBaseFiles({
    pkgName: "shop-landing",
    htmlTitle: "Lumie Store",
  }),
  "src/index.css": INDEX_CSS,
  "src/App.tsx": APP_V1,
};

// ---------- 版本 ----------

const v1: Version = {
  id: "v1",
  label: "项目骨架",
  branchId: "main",
  createdAt: NOW - 3 * DAY,
  diff: { added: 220, removed: 0 },
  files: BASE_FILES,
};

const v2: Version = {
  id: "v2",
  label: "加 Banner",
  branchId: "main",
  parentVersionId: "v1",
  createdAt: NOW - 2 * DAY,
  diff: { added: 48, removed: 6 },
  files: {
    ...BASE_FILES,
    "src/App.tsx": APP_V2,
    "src/components/Banner.tsx": BANNER,
  },
};

const v3: Version = {
  id: "v3",
  label: "加商品卡列表",
  branchId: "main",
  parentVersionId: "v2",
  createdAt: NOW - 1 * DAY,
  diff: { added: 76, removed: 4 },
  files: {
    ...v2.files,
    "src/App.tsx": APP_V3,
    "src/components/ProductGrid.tsx": PRODUCT_GRID,
  },
};

// 手动保存的稳定快照（与父版本文件相同，diff 为 0）
const v3Checkpoint: Version = {
  id: "v3-checkpoint",
  label: "满意版本快照",
  branchId: "main",
  parentVersionId: "v3",
  createdAt: NOW - 20 * HOUR,
  diff: { added: 0, removed: 0 },
  files: v3.files,
};

// ---------- 导出 ----------

export const shopLanding: Session = {
  id: "shop-landing",
  name: "电商落地页",
  description: "夏日大促 · 单页 · banner + 商品卡",
  currentVersionId: "v3-checkpoint",
  createdAt: v1.createdAt,
  updatedAt: v3Checkpoint.createdAt,
  versions: [v1, v2, v3, v3Checkpoint],
  messages: [
    {
      id: "b-m1",
      role: "user",
      branchId: "main",
      text: "我要做一个夏季新品的电商落地页，简洁明亮一些",
      createdAt: v1.createdAt - MIN,
    },
    {
      id: "b-m2",
      role: "assistant",
      branchId: "main",
      text: "先搭一个最小骨架，浅色背景，主标题先占位，方便我们逐步丰富。",
      producedVersionId: "v1",
      createdAt: v1.createdAt,
    },
    {
      id: "b-m3",
      role: "user",
      branchId: "main",
      text: "加一个首屏大 banner，主色调用暖黄",
      createdAt: v2.createdAt - MIN,
    },
    {
      id: "b-m4",
      role: "assistant",
      branchId: "main",
      text: "已加上一个 70vh 的暖黄渐变 Banner，含主标题、副标题和圆角 CTA 按钮。",
      producedVersionId: "v2",
      createdAt: v2.createdAt,
    },
    {
      id: "b-m5",
      role: "user",
      branchId: "main",
      text: "下面再加 4 个热卖商品的卡片",
      createdAt: v3.createdAt - MIN,
    },
    {
      id: "b-m6",
      role: "assistant",
      branchId: "main",
      text: '在 Banner 下方新增"热卖商品"网格区域，4 个商品卡片自适应排列。',
      producedVersionId: "v3",
      createdAt: v3.createdAt,
    },
  ],
};
