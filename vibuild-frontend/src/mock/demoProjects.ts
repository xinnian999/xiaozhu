// ============================================
// Mock 数据：模拟"已生成的项目"
// ============================================
// 协议字段刻意与未来的 SSE 事件协议对齐：files 即 file_write 的累积结果

/** 文件路径 → 内容 */
export type FileMap = Record<string, string>

export type Version = {
  id: string
  label: string
  /** 该版本被创建时的描述（用户那条消息的摘要） */
  summary: string
  createdAt: number
  files: FileMap
  /** 与上一版的 diff 概览 */
  diff: { added: number; removed: number }
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 该消息产出的版本（仅 assistant 消息有） */
  producedVersionId?: string
  /** 此条消息发送时刻 */
  ts: number
}

export type Session = {
  id: string
  name: string
  /** 复制自哪个项目（可选，用于顶部说明文案） */
  duplicatedFrom?: string
  messages: Message[]
  versions: Version[]
  currentVersionId: string
  /** 累计工作时长（秒） */
  workedSeconds: number
}

// ============================================
// Demo 文件内容：一个深色风格的"个人主页"
// ============================================

const PACKAGE_JSON_V1 = `{
  "name": "cool-personal-blog",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.1"
  }
}
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>你好，我是你的名字</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`

const MAIN_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`

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

// —— v1：最初版本（仅 hero）——
const APP_TSX_V1 = `export default function App() {
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

// —— v2：加导航 + CTA ——
const APP_TSX_V2 = `import Nav from './components/Nav'
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

const NAV_TSX = `export default function Nav() {
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

const HERO_TSX_V2 = `export default function Hero() {
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

// —— v3：加项目列表 ——
const APP_TSX_V3 = `import Nav from './components/Nav'
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

const HERO_TSX_V3 = `export default function Hero() {
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

const PROJECTS_TSX = `const list = [
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

const GITIGNORE = `node_modules
dist
.env*.local
.DS_Store
`

// ============================================
// 三个版本的完整快照
// ============================================

const v1: Version = {
  id: 'v1',
  label: '初始化项目',
  summary: '初始化一个深色风格的个人主页',
  createdAt: Date.now() - 1000 * 60 * 60 * 4,
  diff: { added: 680, removed: 0 },
  files: {
    'package.json': PACKAGE_JSON_V1,
    'vite.config.ts': VITE_CONFIG,
    'index.html': INDEX_HTML,
    'README.md': README,
    '.gitignore': GITIGNORE,
    'src/main.tsx': MAIN_TSX,
    'src/index.css': INDEX_CSS,
    'src/App.tsx': APP_TSX_V1,
  },
}

const v2: Version = {
  id: 'v2',
  label: '增加导航与 CTA',
  summary: '增加顶部导航和 hero 区的 CTA 按钮',
  createdAt: Date.now() - 1000 * 60 * 60 * 2,
  diff: { added: 92, removed: 8 },
  files: {
    ...v1.files,
    'src/App.tsx': APP_TSX_V2,
    'src/components/Nav.tsx': NAV_TSX,
    'src/components/Hero.tsx': HERO_TSX_V2,
  },
}

const v3: Version = {
  id: 'v3',
  label: '增加项目展示',
  summary: '加上"近期项目"列表区块',
  createdAt: Date.now() - 1000 * 60 * 25,
  diff: { added: 64, removed: 4 },
  files: {
    ...v2.files,
    'src/App.tsx': APP_TSX_V3,
    'src/components/Hero.tsx': HERO_TSX_V3,
    'src/components/Projects.tsx': PROJECTS_TSX,
  },
}

// ============================================
// Demo session
// ============================================

export const demoSession: Session = {
  id: 'cool-personal-blog-2',
  name: '个人主页（副本）',
  duplicatedFrom: '个人主页',
  currentVersionId: 'v3',
  workedSeconds: 3 * 3600 + 44 * 60,
  versions: [v1, v2, v3],
  messages: [
    {
      id: 'm1',
      role: 'user',
      text: '帮我做一个深色风格的个人主页，要简洁高级一点',
      ts: v1.createdAt - 1000 * 60,
    },
    {
      id: 'm2',
      role: 'assistant',
      text: '好的，我先初始化一个 React + Vite 项目，做一个全屏的 hero 区域，深色基调配少量洋红强调色。',
      producedVersionId: 'v1',
      ts: v1.createdAt,
    },
    {
      id: 'm3',
      role: 'user',
      text: '在顶部加个导航，hero 区下面加两个按钮',
      ts: v2.createdAt - 1000 * 60,
    },
    {
      id: 'm4',
      role: 'assistant',
      text: '已加上一个毛玻璃质感的固定导航条，以及"联系我 / 查看作品"两个按钮，主按钮用洋红色突出。',
      producedVersionId: 'v2',
      ts: v2.createdAt,
    },
    {
      id: 'm5',
      role: 'user',
      text: '再加一个项目展示区块，用卡片排版',
      ts: v3.createdAt - 1000 * 60,
    },
    {
      id: 'm6',
      role: 'assistant',
      text: '在 hero 下方新增"近期项目"区块，使用响应式网格布局展示三个示例项目卡片。',
      producedVersionId: 'v3',
      ts: v3.createdAt,
    },
  ],
}
