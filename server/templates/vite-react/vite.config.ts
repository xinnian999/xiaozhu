import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// WebContainer 里 dev server 默认会监听一个随机端口，
// 这里不固定 port，让 vite 自由选择，server-ready 事件会回传 url。
export default defineConfig({
  plugins: [react()],
})
