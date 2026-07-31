import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 后端 dev server 地址，dev 期把 /api 代理过去，避免 CORS 问题。
// 与 FastAPI dev 的 IPv4 loopback 保持一致，避免 localhost 偶发解析到 ::1。
const BACKEND = "http://127.0.0.1:7200";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 生产构建产物挂在后端的 /admin 路径下（同进程同源），
  // base 必须对应，否则构建出的资源引用路径会指向根路径而 404。
  base: "/admin/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // 与主前端(7300)、后端(7200)区分开的独立开发端口。
    port: 7100,
    strictPort: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
    },
  },
});
