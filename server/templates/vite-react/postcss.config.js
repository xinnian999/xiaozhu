// PostCSS 配置：Vite 处理 CSS 时按顺序跑这两个插件
// tailwindcss   —— 扫描模板里的 class，生成对应的工具类样式
// autoprefixer  —— 自动补全浏览器前缀（-webkit- 等）
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
