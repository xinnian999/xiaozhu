# 项目配置偏好

## 前端web

### 硬规则
- 包管理器使用 `bun`
- 图标库使用 `lucide-react`
- 样式使用 SCSS；组件样式优先 `index.module.scss`
- 多些注释，代码注释必须使用中文
- 开发新内容必须同时兼容移动端布局
- 支持深浅双主题切换：
  - 颜色类样式统一用 CSS 变量（定义在 `styles/_theme.scss`，按 `html[data-theme]` 切换），组件内通过 `var(--color-xxx)` 引用，主题切换自动生效
  - 非颜色的主题差异（阴影、边框结构、装饰性图案等 CSS 变量难以表达的差异）才用 `@include light` mixin 覆盖
- 禁止使用 Tailwind 工具类
- `styles/_variables.scss` 只放与主题无关的尺寸/间距/字号/圆角/断点等编译期常量（SCSS 变量）；颜色不写入此文件
- `styles/_common.scss` 存放 mixin（含 `@mixin light`、`@mixin mobile` 等）
- 动态/数据驱动的值可保留内联 `style`，静态样式写入 SCSS

### SCSS 约束
- SCSS 嵌套必须严格对应 JSX 的 DOM 层级，禁止把子类名平铺到顶层
- 响应式样式必须与 PC 样式分离，并统一写在文件底部
- 响应式断点内的嵌套层级必须与基础样式保持一致

### 组件目录约定
- 板块目录使用 `index.tsx` 作为入口，页面通过 `@/components/...` 引入
- 样式文件与入口同名：CSS Module 用 `index.module.scss`，全局样式用 `index.scss`
- 子组件目录同理：`index.tsx` 作为对外入口，内部实现可使用同名独立文件
- 第三方组件样式放在对应子目录内，保持高内聚

## 后端server
这是个学习项目，因为用户不擅长后端，主要目的是为了学习后端开发，以及python语言。所以后端开发节奏一点要放慢。 依照 @TECH_DESIGN.md 文档的规划，听用户指挥，一次只生成一个小功能，确保用户能理解每一个功能的实现原理和代码。