// ============================================
// API 客户端：axios 实例 + SSE 流式请求
// ============================================

import axios from 'axios'
import { toast } from '@/lib/toast'

// ── 登录 token 的存取 ───────────────────────────────────────────
// token 存在 localStorage：刷新页面 / 重开标签页都还在，做到"记住登录"。
const TOKEN_KEY = 'vibuild:token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/** 带上 Authorization 头（给原生 fetch 用：streamChat / postBuildResult 不走 axios）。 */
function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// 不触发"自动登出跳转"的接口：
//   - login/register：401 是"密码错/邮箱占用"的业务结果，由登录页自己提示，不该跳转
//   - me：恢复登录态时用，401 表示 token 失效，由 auth store 自己 catch 处理
const SILENT_AUTH_PATHS = ['/api/users/login', '/api/users/register', '/api/users/me']

// ── axios 实例 ─────────────────────────────────────────────────
// 走 Vite 代理，baseURL 留空即可（/api/xxx 会被代理到后端）
export const http = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
  timeout: 10_000,
})

// 请求拦截器：每个请求自动带上登录 token
http.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// 响应拦截器：统一处理错误并 toast 提示，调用方不需要自己 catch
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    const url: string = err.config?.url ?? ''
    const isSilent = SILENT_AUTH_PATHS.some((p) => url.includes(p))

    // 已登录后 token 失效/过期：清掉本地 token 并回到登录页。
    // 登录/注册/获取自身信息这三条除外（它们的 401 由调用方自行处理）。
    if (status === 401 && !isSilent) {
      setToken(null)
      toast('登录已过期，请重新登录')
      window.location.href = '/'
      return Promise.reject(new Error('登录已过期'))
    }

    const detail = err.response?.data?.detail ?? err.message
    toast(`请求失败：${detail}`)
    return Promise.reject(new Error(detail))
  },
)

// ── 类型定义（与后端 SSE 事件协议对齐）────────────────────────

export type SSEEvent =
  | { type: 'message_delta'; text: string }
  | { type: 'file_write'; path: string; content: string }
  | { type: 'file_delete'; path: string }
  // AI 调 check_build 时推这个：把暂存的文件揭晓到预览并触发重新构建（无 payload，纯信号）
  | { type: 'preview_refresh' }
  | { type: 'plan_update'; todos: unknown[] }
  // tool_call 带 id（后端的 tool_call_id），用于把随后到达的 tool_result 关联回这张卡
  | { type: 'tool_call'; name: string; args: object; id: string }
  // tool_result：某次工具调用执行完的结果（按 id 关联到对应工具卡，已截断）
  | { type: 'tool_result'; id: string; result: string }
  | { type: 'version'; version_id: number; seq: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type ApiSession = {
  id: string
  title: string | null
  created_at: string
  updated_at: string
}

export type ApiFile = {
  id: number
  session_id: string
  path: string
  content: string
  updated_at: string
}

// 后端 GET /api/models 返回的单个模型。icon 是 @lobehub/icons 的「组件标识符」
// （如 "Qwen.Color" / "Claude.Color"），不是 URL；前端用它解析成图标组件。
// 注意：后端不会返回 group / api_key 这些内部字段，前端拿不到也不需要。
// vision：该模型是否支持识图（多模态图片输入），由后端实测标定，
// 前端据此把「添加图片」置灰 —— 不支持的模型不让传图。
export type ApiModel = {
  id: string
  label: string
  icon: string
  vision: boolean
}

// ── 鉴权（注册 / 登录 / 获取自身信息）────────────────────────────

export type ApiUser = {
  id: string
  email: string
  nickname: string
  avatar: string // 头像种子，前端据此渲染（见 Avatar 组件）
  created_at: string
}

/** 改资料的请求体：字段都可选，传哪个改哪个。 */
export type ProfileUpdate = {
  nickname?: string
  avatar?: string
}

/** 注册新用户。后端返回用户对象（不含 token），注册成功后通常紧跟一次登录。 */
export async function register(email: string, password: string): Promise<ApiUser> {
  const { data } = await http.post<ApiUser>('/api/users/register', { email, password })
  return data
}

/** 登录：邮箱 + 密码换 token，返回 access_token 字符串。 */
export async function login(email: string, password: string): Promise<string> {
  const { data } = await http.post<{ access_token: string; token_type: string }>(
    '/api/users/login',
    { email, password },
  )
  return data.access_token
}

/** 拿当前登录用户信息：带着 token 调，token 失效会 401（用于恢复登录态时校验 token）。 */
export async function getMe(): Promise<ApiUser> {
  const { data } = await http.get<ApiUser>('/api/users/me')
  return data
}

/** 修改当前用户资料（昵称 / 头像），返回更新后的用户对象。 */
export async function updateProfile(payload: ProfileUpdate): Promise<ApiUser> {
  const { data } = await http.patch<ApiUser>('/api/users/me', payload)
  return data
}

// ── 分享（上传构建产物 / 撤销）──────────────────────────────────
// 上传的单个文件：path 相对路径，content 文本或 base64，is_base64 标记二进制。
export type ShareAssetPayload = { path: string; content: string; is_base64: boolean }

/** 上传 dist 并开启分享，返回 share_token。 */
export async function shareBuild(
  sessionId: string,
  files: ShareAssetPayload[],
): Promise<string> {
  const { data } = await http.put<{ share_token: string }>(
    `/api/sessions/${sessionId}/share`,
    { files },
  )
  return data.share_token
}

/** 撤销分享：删除已上传的构建产物，旧链接立即失效。 */
export async function revokeShare(sessionId: string): Promise<void> {
  await http.delete(`/api/sessions/${sessionId}/share`)
}

/** 由 token 拼出访客可访问的完整分享链接（同源 + 结尾斜杠）。 */
export function shareUrl(token: string): string {
  return `${window.location.origin}/shared/${token}/`
}

// ── Sessions CRUD ───────────────────────────────────────────────

export async function createSession(title?: string): Promise<ApiSession> {
  const { data } = await http.post<ApiSession>('/api/sessions', { title: title ?? null })
  return data
}

export async function listSessions(): Promise<ApiSession[]> {
  const { data } = await http.get<ApiSession[]>('/api/sessions')
  return data
}

/** 重命名会话：PATCH 新标题，返回更新后的会话对象。 */
export async function renameSession(sessionId: string, title: string): Promise<ApiSession> {
  const { data } = await http.patch<ApiSession>(`/api/sessions/${sessionId}`, { title })
  return data
}

/** 删除会话：后端会级联清掉它名下的文件 / 消息 / 版本 / 分享产物。无返回体（204）。 */
export async function deleteSession(sessionId: string): Promise<void> {
  await http.delete(`/api/sessions/${sessionId}`)
}

// ── Models ──────────────────────────────────────────────────────

/** 拉取可选模型清单，给模型下拉框渲染。 */
export async function listModels(): Promise<ApiModel[]> {
  const { data } = await http.get<ApiModel[]>('/api/models')
  return data
}

// ── Files ───────────────────────────────────────────────────────

/** 拉取一个 session 下的所有文件（含 content）。返回 {path: content} 扁平字典，
 *  方便直接喂给 WebContainer。 */
export async function listSessionFiles(sessionId: string): Promise<Record<string, string>> {
  const { data } = await http.get<ApiFile[]>(`/api/sessions/${sessionId}/files`)
  const map: Record<string, string> = {}
  for (const f of data) map[f.path] = f.content
  return map
}

// ── Versions（版本历史：单线递增、整快照、回滚即新版）──────────

export type ApiVersion = {
  id: number
  session_id: string
  seq: number
  summary: string | null
  created_at: string
}

/** 拉取一个 session 的版本列表（后端按 seq 倒序，最新在前）。 */
export async function listVersions(sessionId: string): Promise<ApiVersion[]> {
  const { data } = await http.get<ApiVersion[]>(`/api/sessions/${sessionId}/versions`)
  return data
}

/** 回滚到指定版本：后端用该版本快照覆盖当前文件并 append 新版本，
 *  返回回滚后的全部文件，整理成 {path: content} 供前端替换并重挂预览。 */
export async function restoreVersion(
  sessionId: string,
  versionId: number,
): Promise<Record<string, string>> {
  const { data } = await http.post<ApiFile[]>(
    `/api/sessions/${sessionId}/versions/${versionId}/restore`,
  )
  const map: Record<string, string> = {}
  for (const f of data) map[f.path] = f.content
  return map
}

/** 保存编辑器里的改动：把改动文件提交后端，upsert 进 files 表并快照成一个新版本。
 *  返回保存后的全部文件 {path: content}，前端据此替换并刷新预览。 */
export async function saveVersion(
  sessionId: string,
  files: Record<string, string>,
  summary?: string,
): Promise<Record<string, string>> {
  const { data } = await http.post<ApiFile[]>(
    `/api/sessions/${sessionId}/versions`,
    { files, summary },
  )
  const map: Record<string, string> = {}
  for (const f of data) map[f.path] = f.content
  return map
}

// ── Messages ───────────────────────────────────────────────────
export type ApiMessage = {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  text: string
  // 消息种类：'text' 普通对话，'tool' 工具调用卡，'version' 版本卡。缺省 'text'
  kind?: 'text' | 'tool' | 'version'
  // kind==='tool' 存工具参数；kind==='version' 存版本负载 {version_id, seq}
  tool_name?: string | null
  tool_args?: Record<string, unknown> | null
  // 用户随消息发的图片（data URL 列表）；纯文本消息为空 / null
  images?: string[] | null
  created_at: string
}

/** 拉取一个 session 下的所有历史消息（按时间升序）。 */
export async function listSessionMessages(sessionId: string): Promise<ApiMessage[]> {
  const { data } = await http.get<ApiMessage[]>(`/api/sessions/${sessionId}/messages`)
  return data
}

// ── 回报构建结果（唤醒后端 check_build）──────────────────────
// AI 每次调 check_build → 前端构建一次(vite build) + iframe 重载渲染收集运行时错误 →
// 把「编译 + 运行」两类结果一并回报这里，唤醒正挂在 build_store 上等结果的 check_build。
// 每次 check_build 都必须回报一次(成功也要报)，否则后端会干等到超时。
// 走原生 fetch 而非 axios：best-effort 旁路数据，失败要静默，不弹 toast 骚扰用户。
export async function postBuildResult(
  sessionId: string,
  result: { ok: boolean; errors: string; runtime?: boolean },
): Promise<void> {
  try {
    await fetch(`/api/sessions/${sessionId}/build-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(result),
    })
  } catch {
    // 回报失败就算了：后端 check_build 有超时兜底，不会永久卡住
  }
}

// ── SSE 流式对话 ────────────────────────────────────────────────
// SSE 是长连接流，axios 不支持流式消费，这里保留原生 fetch。
// 普通 REST 请求全走 axios，SSE 单独处理，两者分工明确。

export async function* streamChat(
  message: string,
  sessionId: string,
  model: string | null,
  signal?: AbortSignal,
  images: string[] = [],
  // 重试：为 true 时把 retry 标记一起发给后端。后端会忽略 message / images，
  // 改用「最新一轮的用户消息」重新生成，结尾追加一个新版本（详见后端 ChatRequest.retry）。
  retry = false,
): AsyncGenerator<SSEEvent> {
  // 用户主动中断时 fetch / reader 会抛 AbortError，这里统一识别后静默收尾，不弹错误
  const isAbort = (e: unknown) =>
    signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')

  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      // model 为空（清单还没加载完）时不传，让后端用默认模型；有值才带上。
      // images 为空也不传，保持纯文本请求体干净（后端默认空列表）。
      body: JSON.stringify({
        message,
        session_id: sessionId,
        ...(model ? { model } : {}),
        ...(images.length ? { images } : {}),
        ...(retry ? { retry: true } : {}),
      }),
      signal,
    })
  } catch (e: unknown) {
    if (isAbort(e)) return // 还没建立连接就被中断，直接结束
    const msg = e instanceof Error ? e.message : '网络错误'
    toast(`发送失败：${msg}`)
    throw e
  }

  if (!res.ok || !res.body) {
    toast(`发送失败：HTTP ${res.status}`)
    yield { type: 'error', message: `请求失败: ${res.status}` }
    yield { type: 'done' }
    return
  }

  // ReadableStream → 按行拆分 → 解析 SSE 帧
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 每帧以 \n\n 结尾，按此拆分
      const frames = buffer.split('\n\n')
      // 最后一段可能不完整，留到下次拼接
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.trim()
        if (!line.startsWith('data:')) continue
        const json = line.slice('data:'.length).trim()
        try {
          yield JSON.parse(json) as SSEEvent
        } catch {
          // 忽略格式错误的帧
        }
      }
    }
  } catch (e: unknown) {
    if (!isAbort(e)) throw e // 中断以外的读取错误才上抛
  } finally {
    // 中断时主动取消底层流，释放连接，避免悬挂
    reader.cancel().catch(() => {})
  }
}
