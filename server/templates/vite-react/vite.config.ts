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
})
