import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// WebContainer 里 dev server 默认会监听一个随机端口，
// 这里不固定 port，让 vite 自由选择，server-ready 事件会回传 url。
export default defineConfig({
  plugins: [react()],
  resolve: {
    // ★强制 React / react-router-dom 全局只用一份★
    // 不加这个，WebContainer 里装了 react-router-dom 后很容易出现「两份 React」或
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
    // 触发二次重优化 + 页面 reload。在 WebContainer 这点时间差里，新生成的 router
    // chunk 调 useRef 时，旧 React chunk 的 dispatcher 已被置 null，于是偶发地报
    // 「Invalid hook call」「Cannot read properties of null (reading 'useRef')」。
    //
    // 把它们全列进 include，让首次预打包就一次性处理掉，杜绝中途重优化的竞态。
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'],
  },
})
