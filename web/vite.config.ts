import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 后端 dev server 地址。前台经 vite(9000) 代理到它，做到「开发期只用一个端口」。
const BACKEND = "http://localhost:8000";

// 代理响应里若带绝对地址的重定向（SQLAdmin 登录成功用 request.url_for 生成 http://localhost:8000/...），
// 浏览器会跟着跳出 9000、回到 8000。这个钩子把 Location 头里的后端地址改写回 vite 自身，
// 让整个后台流程始终停在 9000 一个端口上。
const rewriteRedirect = (proxy: { on: (e: string, cb: (proxyRes: { headers: Record<string, string | string[] | undefined> }) => void) => void }) => {
  proxy.on("proxyRes", (proxyRes) => {
    const loc = proxyRes.headers["location"];
    if (typeof loc === "string" && loc.startsWith(BACKEND)) {
      proxyRes.headers["location"] = loc.slice(BACKEND.length) || "/";
    }
  });
};

const backendProxy = {
  target: BACKEND,
  changeOrigin: true,
  configure: rewriteRedirect,
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
