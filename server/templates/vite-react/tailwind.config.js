/** @type {import('tailwindcss').Config} */
// content: Tailwind 只会保留这些文件里真正用到的 class，其余全部摇树删掉，
// 所以新增页面/组件目录时要确保被下面的 glob 覆盖到。
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
}
