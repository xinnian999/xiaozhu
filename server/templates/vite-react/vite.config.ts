// 预览模板不安装 @types/node；这些内置模块只在可信 Vite 配置进程中运行。
// @ts-expect-error -- Node 运行时内置模块
import { realpathSync } from 'node:fs'
// @ts-expect-error -- Node 运行时内置模块
import path from 'node:path'
// @ts-expect-error -- Node 运行时内置模块
import process from 'node:process'
// @ts-expect-error -- Node 运行时内置模块
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import autoprefixer from 'autoprefixer'
import tailwindcss from 'tailwindcss'

function isInside(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath)
  return (
    relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  )
}

function filePathFromId(id: string): string | null {
  const cleanId = id.split(/[?#]/, 1)[0]
  if (cleanId.startsWith('file://')) {
    try {
      return fileURLToPath(cleanId)
    } catch {
      throw new Error(`禁止无效 file URL: ${cleanId}`)
    }
  }
  return path.isAbsolute(cleanId) ? path.resolve(cleanId) : null
}

/** 禁止 ?raw、CSS @import 等构建期解析越过任务目录读取 Worker 文件。 */
function projectBoundary(): Plugin {
  const projectRoot = realpathSync(process.cwd())
  const dependenciesRoot = realpathSync(path.join(projectRoot, 'node_modules'))
  const assertInsideBoundary = (
    id: string,
    source: string,
    fail: (message: string) => never,
  ): void => {
    if (id.startsWith('\0')) return
    const lexicalPath = filePathFromId(id)
    if (!lexicalPath) return

    let actualPath = lexicalPath
    try {
      actualPath = realpathSync(lexicalPath)
    } catch {
      // load 阶段通常只会看到存在的文件。缺失路径仍按规范化 lexical path
      // 校验，避免错误处理反而把绝对路径越界放行。
    }
    if (
      !isInside(actualPath, projectRoot)
      && !isInside(actualPath, dependenciesRoot)
    ) {
      fail(`禁止读取项目目录之外的文件: ${source}`)
    }
  }

  return {
    name: 'xiaozhu-project-boundary',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      })
      if (!resolved || resolved.external || resolved.id.startsWith('\0')) return resolved
      assertInsideBoundary(resolved.id, source, (message) => this.error(message))
      return resolved
    },
    load(id) {
      // Vite 的 ?raw/?url 和部分 CSS 资源插件会在 load 阶段自行读文件；
      // 再守一次最终 id，避免其它 resolve hook 绕过上面的检查。
      assertInsideBoundary(id, id, (message) => this.error(message))
      return null
    },
  }
}

// 保留固定模板的 Vite 配置，Worker 构建时只执行 build，不启动 dev server。
// 这里不固定 port，让 vite 自由选择，server-ready 事件会回传 url。
export default defineConfig({
  plugins: [projectBoundary(), react()],
  // 显式使用可信 PostCSS/Tailwind 配置，禁止 postcss-load-config / Tailwind 在任务
  // 根目录自动发现其它后缀的用户 JS 配置。
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          darkMode: 'class',
          content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
          theme: { extend: {} },
          plugins: [],
        }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    // ★强制 React / react-router-dom 全局只用一份★
    // 避免模板依赖与生成代码引入「两份 React」或
    // 「两份 react-router-dom」，引发两类诡异错误：
    //   1. 正确的路由代码也报 "Invalid hook call"（路由 hook 拿到了另一个 React 实例）；
    //   2. 明明 <HashRouter> 包着 <Routes>，却报 "useRoutes() 必须在 <Router> 内"
    //      —— 因为两份 react-router-dom 各有一套 RouterContext，provider 和 consumer 对不上。
    // dedupe 让 Vite 把这几个包始终解析到同一份，路由才能稳定工作。
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  optimizeDeps: {
    // ★首屏就把这些依赖全部预打包★
    // 光有上面的 dedupe 还不够：dedupe 管「模块解析」，而真正出错的是 optimizeDeps
    // 这一步（esbuild 预打包，跑在 dedupe 之前）。
    //
    // 典型翻车场景：初版页面没用路由 → Vite 第一次只优化了 react / react-dom；
    // 之后某次编辑才 import react-router-dom → Vite 把它当「中途新发现的依赖」，
    // 触发二次重优化 + 页面 reload。生成代码如果在这点时间差里引入 router
    // chunk 调 useRef 时，旧 React chunk 的 dispatcher 已被置 null，于是偶发地报
    // 「Invalid hook call」「Cannot read properties of null (reading 'useRef')」。
    //
    // 把它们全列进 include，让首次预打包就一次性处理掉，杜绝中途重优化的竞态。
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
  },
})
