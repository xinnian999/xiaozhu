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

### 数据库迁移（Alembic）
- 表结构由 **Alembic 迁移**统一管理，**不再用 `create_all` 自动建表**（它只建新表、不会给老表加列，会导致线上 schema 漂移）。
- **改了 `app/models/*.py` 后，必须走迁移**，流程：
  1. `uv run alembic revision --autogenerate -m "描述改动"` —— 自动对比模型与库、生成迁移脚本
  2. 打开 `alembic/versions/` 里新脚本，**人工 review** `upgrade()/downgrade()` 是否符合预期
  3. `uv run alembic upgrade head` —— 本地应用
- 新建/拉取迁移后，库要保持最新：`uv run alembic upgrade head`（本地首次建库也靠它）。
- 加新 model 时，记得在 `alembic/env.py` 的 import 里也引入它，否则 autogenerate 看不到。
- SQLite 的 ALTER 能力弱，`env.py` 已开 `render_as_batch=True`，删列/改约束才能正常迁移。
- **生产**：容器启动命令会自动 `alembic upgrade head`（见 Dockerfile），**严禁手动改线上表结构**。给"已有表但没纳入 alembic 的老库"接入时，用 `alembic stamp` 盖基线、不要真建表。

### 后端配置
- `JWT_SECRET` 为**必填**：用 `python -c "import secrets; print(secrets.token_urlsafe(48))"` 生成，写进 `.env`（生产写部署目录的 `.env`）。为空时应用启动会直接报错退出（`app/main.py` 的启动自检）。
- 数据库地址用 `DATABASE_URL` 环境变量覆盖（生产指向挂载的持久化目录，见 docker-compose）。