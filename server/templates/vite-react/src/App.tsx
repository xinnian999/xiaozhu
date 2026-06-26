export default function App() {
  // 用 Tailwind 工具类写默认空状态页，顺便验证模板里 Tailwind 已生效
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#f5f5f7] text-[#6e6e73]">
      <h1 className="text-3xl font-semibold text-[#1d1d1f]">小筑</h1>
      <p>告诉我你想要什么样的页面，我来生成。</p>
    </div>
  )
}
