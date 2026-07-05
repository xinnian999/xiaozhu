import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 后端 dev server 地址。前台经 vite(9000) 代理到它，做到「开发期只用一个端口」。
const BACKEND = "http://localhost:8000";

// changeOrigin 不能开：一旦开启，代理转发给后端的 Host 头会被改成 localhost:8000，
// 后端（SQLAdmin 的 request.url_for / base_url）就会按这个 Host 生成 http://localhost:8000/...
// 的绝对地址（重定向 Location、静态资源 <link>/<script>）。这些资源实际由浏览器直接请求 8000，
// 而 vite 又给页面开了 COEP: require-corp（WebContainer 需要），8000 的响应没有对应的
// Cross-Origin-Resource-Policy 头，于是被浏览器整体拦掉 —— 后台页面直接裸奔、没有样式。
// 保持 Host 头为浏览器原始的 localhost:9000，后端生成的地址就都落在 9000 上，天然同源。
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
    // WebContainer 必需的跨域隔离响应头，缺失则 SharedArrayBuffer 不可用
    port: 9000,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    proxy: {
      // 不 rewrite path：/api/sessions → http://localhost:8000/api/sessions
      "/api": backendProxy,
      // 分享的静态预览也走后端：开发期访客链接 /shared/{token}/ 才能打开
      //（生产环境前后端同源，由后端直接托管，无需代理）
      "/shared": backendProxy,
      // 管理后台 /admin、初始化向导 /setup、健康检查 /health 也代理到后端，
      // 这样开发期只用 vite 一个端口(9000)就能同时访问前台和后台，不必记两个端口。
      // 生产是前后端同源单进程，本就一个端口，无需代理。
      "/admin": backendProxy,
      "/setup": backendProxy,
      "/health": backendProxy,
    },
  },
});
