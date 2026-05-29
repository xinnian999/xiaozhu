import type { FileMap } from '@/types/project'

// ============================================
// mock 项目共享的脚手架文件 + 时间常量
// ============================================
// 三个 demo 项目都基于 React + Vite，下面这些文件几乎完全一样，
// 集中放在这里避免重复，子项目里只覆盖差异部分。

// —— 时间锚点：所有 mock 时间都基于"现在"反推 ——
export const NOW = Date.now()
export const MIN = 60 * 1000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

// —— 通用 vite 配置 ——
export const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`

// —— 通用 main.tsx ——
export const MAIN_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`

// —— 通用 .gitignore ——
export const GITIGNORE = `node_modules
dist
.env*.local
.DS_Store
`

/** 根据项目名生成最朴素的 package.json */
export function buildPackageJson(name: string): string {
  return `{
  "name": "${name}",
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
}

/** 根据网页 title 生成最小 index.html */
export function buildIndexHtml(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

/** 默认主线分支 id（与 lib/sessionBranch 对齐） */
export const MAIN_BRANCH = 'main'

/** 给项目生成"通用三件套"基础文件集合（package.json / vite.config / main.tsx / .gitignore） */
export function buildCommonBaseFiles(opts: {
  pkgName: string
  htmlTitle: string
}): FileMap {
  return {
    'package.json': buildPackageJson(opts.pkgName),
    'vite.config.ts': VITE_CONFIG,
    'index.html': buildIndexHtml(opts.htmlTitle),
    '.gitignore': GITIGNORE,
    'src/main.tsx': MAIN_TSX,
  }
}
