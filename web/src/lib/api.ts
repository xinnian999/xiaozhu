// ============================================
// API 客户端：axios 实例 + SSE 流式请求
// ============================================

import axios from 'axios'
import { toast } from '@/lib/toast'

// ── axios 实例 ─────────────────────────────────────────────────
// 走 Vite 代理，baseURL 留空即可（/api/xxx 会被代理到后端）
export const http = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
  timeout: 10_000,
})

// 请求拦截器：统一加 token、日志等（目前先留空占位）
http.interceptors.request.use((config) => {
  // 未来在这里加：config.headers.Authorization = `Bearer ${token}`
  return config
})

// 响应拦截器：统一处理错误并 toast 提示，调用方不需要自己 catch
http.interceptors.response.use(
  (res) => res,
  (err) => {
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
  | { type: 'plan_update'; todos: unknown[] }
  | { type: 'tool_call'; name: string; args: object }
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

// ── Sessions CRUD ───────────────────────────────────────────────

export async function createSession(title?: string): Promise<ApiSession> {
  const { data } = await http.post<ApiSession>('/api/sessions', { title: title ?? null })
  return data
}

export async function listSessions(): Promise<ApiSession[]> {
  const { data } = await http.get<ApiSession[]>('/api/sessions')
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

// ── Messages ───────────────────────────────────────────────────
export type ApiMessage = {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  text: string
  // 消息种类：'text' 普通对话，'tool' 工具调用卡。缺省 'text'
  kind?: 'text' | 'tool'
  // 仅 kind==='tool' 时有值
  tool_name?: string | null
  tool_args?: Record<string, unknown> | null
  created_at: string
}

/** 拉取一个 session 下的所有历史消息（按时间升序）。 */
export async function listSessionMessages(sessionId: string): Promise<ApiMessage[]> {
  const { data } = await http.get<ApiMessage[]>(`/api/sessions/${sessionId}/messages`)
  return data
}

// ── Browser logs（回传给后端，供 agent 自检报错）──────────────
// 预览的 console 日志只有浏览器看得到，后端 agent 想知道「我写的代码跑起来
// 报错没」，就得靠前端把这些日志推过去。
// 走原生 fetch 而非 axios：这是 best-effort 旁路数据，失败要静默，
// 不能触发 axios 拦截器里的 toast 弹窗骚扰用户。

export type PushLog = { level: string; text: string; ts: number }

export async function pushLogs(sessionId: string, logs: PushLog[]): Promise<void> {
  try {
    await fetch(`/api/sessions/${sessionId}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs }),
    })
  } catch {
    // 旁路数据，回传失败就算了，不打扰用户
  }
}

// ── SSE 流式对话 ────────────────────────────────────────────────
// SSE 是长连接流，axios 不支持流式消费，这里保留原生 fetch。
// 普通 REST 请求全走 axios，SSE 单独处理，两者分工明确。

export async function* streamChat(
  message: string,
  sessionId: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  // 用户主动中断时 fetch / reader 会抛 AbortError，这里统一识别后静默收尾，不弹错误
  const isAbort = (e: unknown) =>
    signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')

  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId }),
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
