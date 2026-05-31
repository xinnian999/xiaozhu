import { create } from 'zustand'
import type { Message } from '@/types/project'
import {
  createSession,
  listSessions,
  listSessionFiles,
  listSessionMessages,
  type ApiSession,
  type ApiMessage,
} from '@/lib/api'

// ============================================
// Session store：多会话管理（对接后端，messages 存内存）
// ============================================
// files 这次接进来了 —— 从后端 GET /api/sessions/{id}/files 拉，
// SSE 的 file_write 事件回来时增量更新。
//
// versionId 是一个内部的"文件快照版本号"：每次 files 内容变了就 +1，
// PreviewPane 通过它判断要不要 syncFiles，避免无限重渲染。

// 内存里维护的单条会话
export type ChatSession = {
  id: string
  title: string
  messages: Message[]
  // 流式输出时，AI 正在打的那条消息（不在 messages 里，渲染时单独展示）
  streamingText: string
  isStreaming: boolean
  // 当前 session 的文件快照：path -> content
  files: Record<string, string>
  // 文件快照版本号，每次 files 变更 +1
  versionId: number
}

type SessionState = {
  sessions: ChatSession[]
  activeId: string | null
  loading: boolean

  init: () => Promise<void>
  createNew: (title?: string) => Promise<ChatSession>
  switchTo: (id: string) => Promise<void>
  /** 回到"无激活会话"的空态首屏，不真正创建会话 */
  goToEmpty: () => void
  appendMessage: (msg: Message) => void
  setStreamingText: (text: string) => void
  /** 开始一轮流式：立刻把 isStreaming 置 true（不等首个 token），让发送按钮即时变成"停止" */
  beginStreaming: () => void
  /** 把当前累积的 streamingText 固化成一条消息并清空，但不结束流式（工具调用前的中途冲刷用） */
  commitStreaming: () => void
  /** 结束一轮流式：冲刷剩余文本并把 isStreaming 置 false（正常结束 / 出错 / 用户中断都走这里） */
  endStreaming: () => void

  /** SSE 收到 file_write：增量写入当前会话的 files */
  applyFileWrite: (path: string, content: string) => void
  /** SSE 收到 file_delete：从当前会话的 files 移除 */
  applyFileDelete: (path: string) => void
  /** 用一组文件整体替换当前会话的 files（回滚到某版本时用） */
  replaceFiles: (files: Record<string, string>) => void

  activeSession: () => ChatSession | null

  // ── 兼容旧版 WorkArea 组件 ─────────────────────────────────────
  session: { id: string; name: string; currentVersionId: string; versions: []; messages: [] }
  projects: []
  /** 当前 "version"：把当前 session 的 files 包成 PreviewPane 期望的形状 */
  currentVersion: () => { id: string; label: string; files: Record<string, string>; branchId: string; createdAt: number; diff: { added: number; removed: number } }
  setCurrentProject: (id: string) => void
  setCurrentVersion: (id: string) => void
  createProject: () => { id: string; name: string }
}

// ── 工具函数 ───────────────────────────────────────────────────

function fromApi(api: ApiSession): ChatSession {
  return {
    id: api.id,
    title: api.title ?? '未命名会话',
    messages: [],
    streamingText: '',
    isStreaming: false,
    files: {},
    versionId: 0,
  }
}

/** 把后端的 ApiMessage 转成前端 Message 类型。
 *  branchId 现阶段统一 'main'，后端没有这个概念但前端类型要求有。 */
function fromApiMessage(m: ApiMessage): Message {
  return {
    id: `srv-${m.id}`,
    role: m.role,
    text: m.text,
    createdAt: new Date(m.created_at).getTime(),
    branchId: 'main',
  }
}

export function makeMessage(
  role: 'user' | 'assistant',
  text: string,
  extra?: Partial<Message>,
): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    text,
    createdAt: Date.now(),
    branchId: 'main',
    ...extra,
  }
}

// EMPTY_VERSION 仅在没有激活 session 时返回，必须是常量 —— 否则 zustand selector
// 每次返回新对象引用都不等，触发无限重渲染。
const EMPTY_VERSION = {
  id: 'v0',
  label: '等待生成',
  files: {} as Record<string, string>,
  branchId: 'main',
  createdAt: 0,
  diff: { added: 0, removed: 0 },
}

// 缓存 currentVersion 包装对象：同一 session + 同一 versionId 必须返回同一个引用，
// 否则 PreviewPane 的 useEffect 依赖 currentVersion.files 会无限触发 syncFiles。
const versionCache = new Map<string, { versionId: number; value: ReturnType<SessionState['currentVersion']> }>()

function getVersionFor(session: ChatSession) {
  const cached = versionCache.get(session.id)
  if (cached && cached.versionId === session.versionId) return cached.value
  const value = {
    id: `${session.id}@${session.versionId}`,
    label: session.versionId === 0 ? '模板' : `v${session.versionId}`,
    files: session.files,
    branchId: 'main',
    createdAt: 0,
    diff: { added: 0, removed: 0 },
  }
  versionCache.set(session.id, { versionId: session.versionId, value })
  return value
}

// ── Store ──────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeId: null,
  loading: false,

  init: async () => {
    set({ loading: true })
    try {
      const apiSessions = await listSessions()
      const sessions = apiSessions.map(fromApi)

      // 从 URL 取 sessionId：存在则尝试激活；不存在或非法 → 不主动创建会话，
      // 让 UI 显示"全屏对话框"状态，等用户首条消息触发创建
      const url = new URL(window.location.href)
      const urlId = url.searchParams.get('sessionId')
      const targetId = urlId && sessions.find((s) => s.id === urlId) ? urlId : null

      set({ sessions, activeId: targetId })

      if (targetId) {
        await get().switchTo(targetId)
      } else if (urlId) {
        // URL 里有 sessionId 但找不到对应会话，把它从 URL 上清理掉，避免一直误导
        url.searchParams.delete('sessionId')
        window.history.replaceState(null, '', url.toString())
      }
    } catch (e) {
      console.error('初始化会话失败', e)
      throw e
    } finally {
      set({ loading: false })
    }
  },

  createNew: async (title) => {
    const api = await createSession(title ?? '新会话')
    const session = fromApi(api)
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeId: session.id,
    }))
    // 同步 URL，刷新后能恢复到同一个会话
    const url = new URL(window.location.href)
    url.searchParams.set('sessionId', session.id)
    window.history.replaceState(null, '', url.toString())
    // 新建会话后端已经预置了模板，立即拉过来给 WebContainer 用
    await get().switchTo(session.id)
    return session
  },

  switchTo: async (id) => {
    set({ activeId: id })
    // 同步 URL —— 切换会话也要让地址栏跟着变，分享链接才能定位
    const url = new URL(window.location.href)
    if (url.searchParams.get('sessionId') !== id) {
      url.searchParams.set('sessionId', id)
      window.history.replaceState(null, '', url.toString())
    }
    // 切换到的目标会话如果还没拉过文件（files 为空且 versionId 为 0），从后端拉一次
    const target = get().sessions.find((s) => s.id === id)
    if (!target) return
    if (Object.keys(target.files).length > 0) return  // 已加载过，不重复拉
    // 并行拉文件和消息 —— 两个请求互相不依赖，并发更快
    try {
      const [files, apiMessages] = await Promise.all([
        listSessionFiles(id),
        listSessionMessages(id),
      ])
      const messages = apiMessages.map(fromApiMessage)
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === id
            ? { ...sess, files, messages, versionId: sess.versionId + 1 }
            : sess,
        ),
      }))
    } catch (e) {
      console.error(`加载会话 ${id} 的内容失败`, e)
    }
  },

  goToEmpty: () => {
    // 把激活态清掉，路由也去掉 sessionId，UI 自然回到空态首屏
    set({ activeId: null })
    const url = new URL(window.location.href)
    if (url.searchParams.has('sessionId')) {
      url.searchParams.delete('sessionId')
      window.history.replaceState(null, '', url.toString())
    }
  },

  appendMessage: (msg) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, messages: [...sess.messages, msg] } : sess,
      ),
    }))
  },

  setStreamingText: (text) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, streamingText: text, isStreaming: true } : sess,
      ),
    }))
  },

  beginStreaming: () => {
    const id = get().activeId
    if (!id) return
    // 立刻进入流式态：发送按钮即时切成"停止"，MessageList 也马上出现"思考中"光标气泡
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, isStreaming: true } : sess,
      ),
    }))
  },

  commitStreaming: () => {
    const id = get().activeId
    if (!id) return
    // 把累积文本固化成一条 assistant 消息后清空；保持 isStreaming 不变（本轮还没结束）
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id || !sess.streamingText) return sess
        return {
          ...sess,
          messages: [...sess.messages, makeMessage('assistant', sess.streamingText)],
          streamingText: '',
        }
      }),
    }))
  },

  endStreaming: () => {
    const id = get().activeId
    if (!id) return
    // 冲刷剩余文本（有才追加）并结束流式态；无条件把 isStreaming 复位，避免中断后卡在"停止"
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        const messages = sess.streamingText
          ? [...sess.messages, makeMessage('assistant', sess.streamingText)]
          : sess.messages
        return { ...sess, messages, streamingText: '', isStreaming: false }
      }),
    }))
  },

  applyFileWrite: (path, content) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id
          ? {
              ...sess,
              files: { ...sess.files, [path]: content },
              versionId: sess.versionId + 1,
            }
          : sess,
      ),
    }))
  },

  applyFileDelete: (path) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        if (!(path in sess.files)) return sess
        const { [path]: _omit, ...rest } = sess.files
        return { ...sess, files: rest, versionId: sess.versionId + 1 }
      }),
    }))
  },

  replaceFiles: (files) => {
    const id = get().activeId
    if (!id) return
    // 整体替换 files 并 +versionId，PreviewPane 监听到 currentVersion.files 变化后
    // 会增量同步进 WebContainer（不在这里碰容器，保持 store 纯数据）。
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, files, versionId: sess.versionId + 1 } : sess,
      ),
    }))
  },

  activeSession: () => {
    const { sessions, activeId } = get()
    return sessions.find((s) => s.id === activeId) ?? null
  },

  // ── 兼容旧版 WorkArea 组件的字段 ──────────
  session: { id: '', name: '', currentVersionId: 'v0', versions: [], messages: [] },
  projects: [],
  currentVersion: () => {
    const active = get().activeSession()
    if (!active) return EMPTY_VERSION
    return getVersionFor(active)
  },
  setCurrentProject: () => {},
  setCurrentVersion: () => {},
  createProject: () => ({ id: '', name: '' }),
}))
