import type { FileMap, Session, Version } from '@/types/project'
import { buildCommonBaseFiles, HOUR, MIN, NOW } from './_shared'

// ============================================
// 项目 A：个人主页
// ============================================
// 版本树：
//   main:        v1 → v2 → v3
//   light-hero:        └── v2-light  （从 v2 分出，浅色实验）

// ---------- 源码片段 ----------

const INDEX_CSS = `:root {
  font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  min-height: 100vh;
  background: #0a0a0a;
  color: #f5f5f5;
}
`

const APP_V1 = `export default function App() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 8vw',
    }}>
      <h1 style={{ fontSize: 'clamp(48px, 8vw, 96px)', fontWeight: 700, lineHeight: 1.05 }}>
        你好，我是 <span style={{ color: '#f43f5e' }}>你的名字</span>
      </h1>
      <p style={{ marginTop: 24, color: '#a3a3a3', fontSize: 18 }}>
        全栈开发者 · 设计师 · 创作者
      </p>
    </main>
  )
}
`

const APP_V2 = `import Nav from './components/Nav'
import Hero from './components/Hero'

export default function App() {
  return (
    <>
      <Nav />
      <Hero />
    </>
  )
}
`

const NAV = `export default function Nav() {
  return (
    <nav style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '20px 6vw',
      backdropFilter: 'blur(8px)',
      background: 'rgba(10,10,10,0.6)',
    }}>
      <div style={{ fontFamily: 'monospace', fontSize: 18 }}>&lt;YourName /&gt;</div>
      <ul style={{ display: 'flex', gap: 32, listStyle: 'none', color: '#a3a3a3', fontSize: 14 }}>
        <li>首页</li><li>关于</li><li>项目</li><li>博客</li><li>联系</li>
      </ul>
    </nav>
  )
}
`

const HERO_V2 = `export default function Hero() {
  return (
    <section style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '0 8vw',
    }}>
      <h1 style={{ fontSize: 'clamp(48px, 8vw, 96px)', fontWeight: 700, lineHeight: 1.05 }}>
        你好，我是 <span style={{ color: '#f43f5e' }}>你的名字</span>
      </h1>
      <p style={{ marginTop: 16, color: '#a3a3a3', fontSize: 18 }}>
        全栈开发者 · 设计师 · 创作者
      </p>
      <p style={{ marginTop: 24, color: '#737373', maxWidth: 520, lineHeight: 1.7 }}>
        我专注于构建优雅的用户界面和高性能的 Web 应用。热爱开源，喜欢分享技术心得。
      </p>
      <div style={{ marginTop: 36, display: 'flex', gap: 12 }}>
        <button style={{
          background: '#f43f5e', color: 'white', border: 0,
          padding: '12px 24px', borderRadius: 8, fontSize: 14, cursor: 'pointer',
        }}>联系我</button>
        <button style={{
          background: 'transparent', color: '#f5f5f5',
          border: '1px solid #262626', padding: '12px 24px',
          borderRadius: 8, fontSize: 14, cursor: 'pointer',
        }}>查看作品 →</button>
      </div>
    </section>
  )
}
`

const APP_V3 = `import Nav from './components/Nav'
import Hero from './components/Hero'
import Projects from './components/Projects'

export default function App() {
  return (
    <>
      <Nav />
      <Hero />
      <Projects />
    </>
  )
}
`

const HERO_V3 = `export default function Hero() {
  return (
    <section style={{
      minHeight: '100vh',
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      padding: '0 8vw',
    }}>
      <h1 style={{ fontSize: 'clamp(48px, 8vw, 96px)', fontWeight: 700, lineHeight: 1.05 }}>
        你好，我是 <span style={{ color: '#f43f5e' }}>你的名字</span>
      </h1>
      <p style={{ marginTop: 16, color: '#a3a3a3', fontSize: 18 }}>
        全栈开发者 · 设计师 · 创作者
      </p>
      <p style={{ marginTop: 24, color: '#737373', maxWidth: 520, lineHeight: 1.7 }}>
        我专注于构建优雅的用户界面和高性能的 Web 应用。热爱开源，喜欢分享技术心得，致力于用代码创造有价值的产品。
      </p>
      <div style={{ marginTop: 36, display: 'flex', gap: 12 }}>
        <button style={{
          background: '#f43f5e', color: 'white', border: 0,
          padding: '12px 24px', borderRadius: 8, fontSize: 14, cursor: 'pointer',
        }}>📧 联系我</button>
        <button style={{
          background: 'transparent', color: '#f5f5f5',
          border: '1px solid #262626', padding: '12px 24px',
          borderRadius: 8, fontSize: 14, cursor: 'pointer',
        }}>查看作品 ↓</button>
      </div>
      <div style={{ marginTop: 48, display: 'flex', gap: 16, color: '#737373' }}>
        <span>◯ GitHub</span><span>▢ LinkedIn</span><span>✉ Email</span>
      </div>
    </section>
  )
}
`

const PROJECTS = `const list = [
  { title: 'Aurora UI', desc: '一套面向暗色界面的组件库', tag: 'TypeScript · React' },
  { title: 'Pixel Garden', desc: '像素艺术创作工具', tag: 'Canvas · WebGL' },
  { title: 'Lumen', desc: '极简笔记应用，支持 Markdown', tag: 'Tauri · Rust' },
]

export default function Projects() {
  return (
    <section style={{ padding: '120px 8vw', borderTop: '1px solid #1a1a1a' }}>
      <h2 style={{ fontSize: 'clamp(32px, 5vw, 56px)', fontWeight: 600, marginBottom: 48 }}>
        近期项目
      </h2>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {list.map((p) => (
          <article key={p.title} style={{
            padding: 24,
            border: '1px solid #1a1a1a',
            borderRadius: 12,
            background: '#0d0d0d',
          }}>
            <h3 style={{ fontSize: 20, marginBottom: 8 }}>{p.title}</h3>
            <p style={{ color: '#a3a3a3', marginBottom: 16, lineHeight: 1.6 }}>{p.desc}</p>
            <div style={{ color: '#737373', fontSize: 12, fontFamily: 'monospace' }}>{p.tag}</div>
          </article>
        ))}
      </div>
    </section>
  )
}
`

const README = `# Cool Personal Blog

一个由 vibuild 生成的个人主页项目。

## 开发

\`\`\`bash
bun install
bun dev
\`\`\`
`

// ---------- 文件集合 ----------

const BASE_FILES: FileMap = {
  ...buildCommonBaseFiles({ pkgName: 'cool-personal-blog', htmlTitle: '你好，我是你的名字' }),
  'README.md': README,
  'src/index.css': INDEX_CSS,
  'src/App.tsx': APP_V1,
}

// ---------- 版本 ----------

const v1: Version = {
  id: 'v1',
  label: '初始化项目',
  summary: '初始化一个深色风格的个人主页',
  branchId: 'main',
  createdAt: NOW - 4 * HOUR,
  diff: { added: 680, removed: 0 },
  authorRole: 'assistant',
  files: BASE_FILES,
}

const v2: Version = {
  id: 'v2',
  label: '增加导航与 CTA',
  summary: '增加顶部导航和 hero 区的 CTA 按钮',
  branchId: 'main',
  parentVersionId: 'v1',
  createdAt: NOW - 2 * HOUR,
  diff: { added: 92, removed: 8 },
  authorRole: 'assistant',
  files: {
    ...BASE_FILES,
    'src/App.tsx': APP_V2,
    'src/components/Nav.tsx': NAV,
    'src/components/Hero.tsx': HERO_V2,
  },
}

const v3: Version = {
  id: 'v3',
  label: '增加项目展示',
  summary: '加上"近期项目"列表区块',
  branchId: 'main',
  parentVersionId: 'v2',
  createdAt: NOW - 25 * MIN,
  diff: { added: 64, removed: 4 },
  authorRole: 'assistant',
  files: {
    ...v2.files,
    'src/App.tsx': APP_V3,
    'src/components/Hero.tsx': HERO_V3,
    'src/components/Projects.tsx': PROJECTS,
  },
}

const v2Light: Version = {
  id: 'v2-light',
  label: '尝试浅色 Hero',
  summary: '在 v2 基础上试验更亮的 hero 配色',
  branchId: 'branch-light-hero',
  parentVersionId: 'v2',
  createdAt: NOW - 40 * MIN,
  diff: { added: 18, removed: 6 },
  authorRole: 'assistant',
  files: {
    ...v2.files,
    'src/index.css': INDEX_CSS.replace('background: #0a0a0a', 'background: #f5f3ef')
      .replace('color: #f5f5f5', 'color: #1a1a1a'),
  },
}

// ---------- 导出 ----------

export const personalBlog: Session = {
  id: 'cool-personal-blog',
  name: '个人主页',
  description: '深色风格 · 单页 · 含 hero / nav / projects',
  currentVersionId: 'v3',
  createdAt: v1.createdAt,
  updatedAt: v3.createdAt,
  versions: [v1, v2, v3, v2Light],
  messages: [
    {
      id: 'a-m1', role: 'user', branchId: 'main',
      text: '帮我做一个深色风格的个人主页，要简洁高级一点',
      ts: v1.createdAt - MIN,
    },
    {
      id: 'a-m2', role: 'assistant', branchId: 'main',
      text: '好的，我先初始化一个 React + Vite 项目，做一个全屏的 hero 区域，深色基调配少量洋红强调色。',
      producedVersionId: 'v1', ts: v1.createdAt,
    },
    {
      id: 'a-m3', role: 'user', branchId: 'main',
      text: '在顶部加个导航，hero 区下面加两个按钮',
      ts: v2.createdAt - MIN,
    },
    {
      id: 'a-m4', role: 'assistant', branchId: 'main',
      text: '已加上一个毛玻璃质感的固定导航条，以及"联系我 / 查看作品"两个按钮，主按钮用洋红色突出。',
      producedVersionId: 'v2', ts: v2.createdAt,
    },
    {
      id: 'a-m5', role: 'user', branchId: 'main',
      text: '再加一个项目展示区块，用卡片排版',
      ts: v3.createdAt - MIN,
    },
    {
      id: 'a-m6', role: 'assistant', branchId: 'main',
      text: '在 hero 下方新增"近期项目"区块，使用响应式网格布局展示三个示例项目卡片。',
      producedVersionId: 'v3', ts: v3.createdAt,
    },
    {
      id: 'a-m5b', role: 'user', branchId: 'branch-light-hero',
      text: '试一下把 hero 背景改成浅色会不会更干净',
      ts: v2Light.createdAt - MIN,
    },
    {
      id: 'a-m6b', role: 'assistant', branchId: 'branch-light-hero',
      text: '已在实验分支调整全局背景为浅暖色，hero 对比度保持不变，方便与主线对比。',
      producedVersionId: 'v2-light', ts: v2Light.createdAt,
    },
  ],
}

/** 给"新建空白项目"模板复用的最小文件集合 */
export const personalBlogBlankFiles: FileMap = {
  ...BASE_FILES,
  'README.md': README,
}
