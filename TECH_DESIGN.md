# Vibuild — 技术方案 v0.1

> 类 V0 的 AI 代码生成平台。练手项目，目标是学习 Python + LangChain / LangGraph / DeepAgents。

---

## 1. 项目目标与边界

### MVP目标
- 对话式输入需求 → AI 生成一个可运行的前端项目（React/Vite 类）
- 前端用 **WebContainer** 在浏览器里跑起来，实时预览
- 生成过程**流式**反馈：todo 规划、文件写入、消息增量
- 会话可持久化，能继续在已有项目上迭代

### 二期
- ❌ 用户系统 / 登录 / 多租户
- ❌ 后端代码执行沙箱（WebContainer 本身就是沙箱）
- ❌ 生成非 Node 项目（Python/Go 等，WebContainer 跑不了）
- ❌ 部署 / 域名分发 / 协作编辑
- ❌ 任何 "为以后扩展" 的抽象层

---

## 2. 学习目标对照

| 想学的东西 | 在项目里对应什么 |
|---|---|
| Python 语法/工程化 | 后端全部代码 + `uv` + `ruff` + Pydantic |
| FastAPI | HTTP 路由 + SSE 流式端点 |
| LangChain | 调 Claude 模型、消息抽象 |
| LangGraph | Agent 状态机 + checkpoint 持久化 |
| DeepAgents | planner / coder 子 agent + 虚拟文件系统 |

> 后端**手写**，不要从模板 clone；agent 编排**直接用现成抽象**，不要自己造。

---

## 3. 架构图

```
┌────────────────────────────────────────┐
│  Frontend (Vite + React)               │
│  ┌─────────┐   ┌──────────────────┐    │
│  │ Chat UI │   │ WebContainer     │    │
│  │  (SSE)  │   │  ├─ 文件树       │    │
│  │         │   │  ├─ 编辑器       │    │
│  └────┬────┘   │  └─ 预览 iframe  │    │
│       │        └──────────────────┘    │
└───────┼────────────────────────────────┘
        │ HTTP + SSE
┌───────▼────────────────────────────────┐
│  Backend (FastAPI, Python 3.12+)       │
│   Routes                               │
│    POST /api/sessions                  │
│    POST /api/chat   (SSE stream)       │
│    GET  /api/sessions/{id}/files       │
│   ──────────────────────────────────   │
│   Agent (DeepAgents on LangGraph)      │
│     Planner subagent ─┐                │
│                       ├─ shared FS     │
│     Coder   subagent ─┘                │
│     Tools: write_file/read_file/ls/rm  │
│   ──────────────────────────────────   │
│   Persistence: SQLite                  │
│     sessions / messages / files        │
│     LangGraph SqliteSaver (checkpoint) │
└────────────────────────────────────────┘
```

---

## 4. 后端选型

| 维度 | 选型 | 理由 |
|---|---|---|
| Python | 3.12+ | 类型系统更好 |
| Web 框架 | FastAPI | async 原生，类型友好 |
| 包管理 | `uv` | 比 pip 快十倍，现代 |
| Lint/Format | `ruff` | 一把梭 |
| 数据校验 | Pydantic v2 | 类似 TS interface |
| 配置 | pydantic-settings + `.env` | 类 NestJS config |
| 持久化 | SQLite + SQLAlchemy 2.0 (async) | 单机够用 |
| Agent | LangGraph + DeepAgents | 学习目标 |
| 模型 | Claude Sonnet 4.6（`langchain-anthropic`） | 代码生成最强 |
| 流式 | FastAPI `StreamingResponse` (SSE) | 比 WebSocket 简单 |

---

## 5. 后端目录结构

```
backend/
├── pyproject.toml
├── .env
├── .env.example
└── app/
    ├── main.py              # FastAPI 入口 + CORS
    ├── config.py            # pydantic-settings 配置
    ├── db.py                # SQLAlchemy engine/session
    ├── api/
    │   ├── chat.py          # POST /api/chat (SSE)
    │   └── sessions.py      # 会话 CRUD
    ├── agents/
    │   ├── graph.py         # create_deep_agent 装配
    │   ├── tools.py         # write_file/read_file/ls/rm
    │   ├── prompts.py       # planner/coder system prompts
    │   └── events.py        # graph event → SSE event 映射
    └── models/
        ├── session.py       # ORM + Pydantic schema
        └── file.py
```

---

## 6. SSE 事件协议（前后端共享，早期定死）

### 为什么需要流？

**一条 SSE 连接，多种事件混合推送**。流式不是为了让用户围观代码逐字生成，而是为了：

1. **渐进式预览**（核心爽点）：LLM 写完整个项目需 30s–2min。文件陆续到达 → WebContainer 陆续 mount → Vite 热更新 → 用户**肉眼可见地看着预览长出来**，而不是盯一分钟 spinner。
2. **对话打字效果**：助手回复（"好的，我来建一个 Todo App…"）按 token 流，类似 ChatGPT 体验。
3. **进度反馈**：`tool_call` 事件让前端显示"正在写入 App.tsx…"，避免长时间无响应像坏掉。

**重要**：`file_write` 不是按 token 流的，是一个文件**写完整后**作为一个事件推送。前端**不在 chat 区显示文件内容**，只用它 mount 到 WebContainer，chat 里最多显示"已生成 X 个文件"。用户关注的是预览，不是代码本身。

### 事件类型

```ts
type Event =
  | { type: 'plan_update';   todos: Todo[] }
  | { type: 'file_write';    path: string; content: string }  // 整文件，非 token 流
  | { type: 'file_delete';   path: string }
  | { type: 'message_delta'; text: string }                   // 助手对话，token 流
  | { type: 'tool_call';     name: string; args: object }     // 进度提示用
  | { type: 'error';         message: string }
  | { type: 'done' }
```

> 改协议成本高：Pydantic 模型 + 前端 type 双份写，**M2 之前定下来不动**。

---

## 7. 核心数据流

1. 用户输入 → `POST /api/chat { session_id, message }`
2. 后端载入/创建 LangGraph 状态（含已有 todos + files）
3. **Planner** 拆 todo → 推 `plan_update`
4. **Coder** 调 `write_file` → 推 `file_write { path, content }`
5. 前端收到 `file_write` 立即写入 WebContainer FS，Vite 自动热更新
6. graph 结束 → 推 `done`，前端关闭 stream

---


## 10. 已知风险（先记下，不预先解决）

- **WebContainer 跨域**：前端服务需返回
  `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`，
  否则 `SharedArrayBuffer` 不可用，WebContainer 起不来。
- **事件协议版本化**：协议一改前后端都得动，所以早定。
- **Token 成本**：完整生成一个项目 5w–10w token 起步。dev 期用 `max_tokens` 限制 + 缓存历史。
- **DeepAgents 子 agent 状态隔离**：子 agent 的 state/context 如何共享，M5 之前先读源码再设计，避免推倒重来。
- **WebContainer 商业用途**：免费授权对个人/学习项目 OK，未来要商用得查协议。

---

## 11. 关键决策记录（ADR）

### ADR-001：前端不用 Vercel AI SDK，走原生 SSE

**日期**：2026-05-28
**决定**：前端用 `fetch` + `ReadableStream` 自己解析 SSE，不引入 `@ai-sdk/react` / `useChat`。
**对照方案**：参考课程 `agui-backend`（NestJS + `@ai-sdk/langchain`）路线很顺；Python 侧也有 `py-ai-datastream` 等社区适配器。

**为什么不选**：
- JS 生态里 AI SDK ↔ LangChain 有官方适配器（`@ai-sdk/langchain`），跟 AI SDK 主仓同步升版本；Python 侧只有社区适配器，AI SDK 大版本一升就要等维护。
- 本项目主事件是 `file_write` / `plan_update`，不是普通 chat。塞进 AI SDK 的 `data parts` 能做但便利所剩无几，`useChat` 的核心价值发挥不出来。
- 自定义 SSE 协议 + 原生解析极其直白：curl 都能调试，30 行前端代码搞定，不绑前端框架。
- 学习目标是 LangChain Python + LangGraph，不是 AI SDK 协议。

**何时复议**：如果 MVP 之后引入复杂 chat 历史管理、多模态消息、附件上传等 AI SDK 强项功能，可重新评估。

---