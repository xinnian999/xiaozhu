import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 后端 dev server 地址。前台经 vite(7300) 代理到它，做到「开发期只用一个端口」。
// FastAPI dev 明确监听 IPv4 loopback。不要写 localhost：Node 在不同机器/版本上可能
// 优先解析到 ::1，后端重启窗口里会表现为偶发 ECONNREFUSED。
const BACKEND = "http://127.0.0.1:7200";

// 保持 Host 头为浏览器原始的 localhost:7300，让后端生成的绝对地址继续走 Vite 代理。
const backendProxy = {
  target: BACKEND,
  changeOrigin: false,
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // macOS Control Center 默认占用 7000；使用 7300 避免开发环境与系统服务冲突。
    port: 7300,
    // 端口错位会让 preview.localhost、FastAPI capability 和实际前端互相指向不同实例。
    // 被占用时直接失败，绝不能静默降级到 7301。
    strictPort: true,
    proxy: {
      // 不 rewrite path：/api/sessions → http://localhost:7200/api/sessions
      "/api": backendProxy,
      // 分享的静态预览也走后端：开发期访客链接 /shared/{token}/ 才能打开
      //（生产环境前后端同源，由后端直接托管，无需代理）
      "/shared": backendProxy,
      // 管理后台 /admin、初始化向导 /setup、健康检查 /health 也代理到后端，
      // 这样开发期只用 vite 一个端口(7300)就能同时访问前台和后台，不必记两个端口。
      // 生产是前后端同源单进程，本就一个端口，无需代理。
      "/admin": backendProxy,
      "/setup": backendProxy,
      "/health": backendProxy,
    },
  },
});
