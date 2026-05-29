import { create } from 'zustand'
import type { Message } from '@/types/project'
import { createSession, listSessions, type ApiSession } from '@/lib/api'

// ============================================
// Session store：多会话管理（对接后端，messages 存内存）
// ============================================
// 这一阶段的 Session 概念比 types/project.ts 里的轻量得多：
//   - sessions 来自后端 /api/sessions
//   - messages 纯内存（刷新丢失），等 LangGraph 接入后再持久化
//   - versions / files 暂时保留字段但不使用，等项目生成功能接入

// 内存里维护的单条会话（不含后端的 Session 完整模型）
export type ChatSession = {
  id: string
  title: string
  messages: Message[]
  // 流式输出时，AI 正在打的那条消息（不在 messages 里，渲染时单独展示）
  streamingText: string
  isStreaming: boolean
}

type SessionState = {
  /** 所有会话（顶部菜单列表） */
  sessions: ChatSession[]
  /** 当前激活的会话 id */
  activeId: string | null
  /** 是否正在从后端加载会话列表 */
  loading: boolean

  /** 初始化：从后端拉取会话列表，没有则创建默认会话 */
  init: () => Promise<void>

  /** 新建会话（调后端创建，写入本地列表并切换过去） */
  createNew: (title?: string) => Promise<void>

  /** 切换到某个会话 */
  switchTo: (id: string) => void

  /** 往当前会话追加一条消息 */
  appendMessage: (msg: Message) => void

  /** 更新流式输出文本 */
  setStreamingText: (text: string) => void

  /** 结束流式输出：把 streamingText 固化为一条 assistant 消息 */
  commitStreaming: () => void

  /** 取当前激活会话 */
  activeSession: () => ChatSession | null

  // ── 兼容旧版 WorkArea 组件，等项目生成功能接入后替换 ──────────
  /** 旧 store 的 session 字段（空壳，供 WorkArea 不报错） */
  session: { id: string; name: string; currentVersionId: string; versions: []; messages: [] }
  /** 旧 store 的 projects 字段 */
  projects: []
  /** 旧 store 的 currentVersion 方法（返回空文件占位版本） */
  currentVersion: () => { id: string; label: string; files: Record<string, string>; branchId: string; createdAt: number; diff: { added: number; removed: number } }
  setCurrentProject: (id: string) => void
  setCurrentVersion: (id: string) => void
  createProject: () => { id: string; name: string }
}

// ── 工具函数 ───────────────────────────────────────────────────

/** 把后端的 ApiSession 转成内存的 ChatSession */
function fromApi(api: ApiSession): ChatSession {
  return {
    id: api.id,
    title: api.title ?? '未命名会话',
    messages: [],
    streamingText: '',
    isStreaming: false,
  }
}

/** 生成一条消息对象 */
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

// 稳定常量：currentVersion() stub 必须每次返回同一个对象引用，
// 否则 zustand selector 每次比较都不等，触发无限重渲染。
const EMPTY_VERSION = {
  id: 'v0',
  label: '等待生成',
  files: {} as Record<string, string>,
  branchId: 'main',
  createdAt: 0,
  diff: { added: 0, removed: 0 },
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
      if (apiSessions.length > 0) {
        // 已有会话：加载列表，激活最新一条
        const sessions = apiSessions.map(fromApi)
        set({ sessions, activeId: sessions[0].id })
      } else {
        // 空库：自动创建第一个会话
        const api = await createSession('第一个对话')
        const session = fromApi(api)
        set({ sessions: [session], activeId: session.id })
      }
    } catch (e) {
      console.error('初始化会话失败', e)
      // 把错误暴露出去，让 App 层可以 toast 提示
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
  },

  switchTo: (id) => {
    if (id === get().activeId) return
    set({ activeId: id })
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

  commitStreaming: () => {
    const id = get().activeId
    if (!id) return
    const session = get().sessions.find((s) => s.id === id)
    if (!session || !session.streamingText) return
    const msg = makeMessage('assistant', session.streamingText)
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id
          ? { ...sess, messages: [...sess.messages, msg], streamingText: '', isStreaming: false }
          : sess,
      ),
    }))
  },

  activeSession: () => {
    const { sessions, activeId } = get()
    return sessions.find((s) => s.id === activeId) ?? null
  },

  // ── 兼容旧版 WorkArea 组件的 stub，等项目生成接入后替换 ──────────
  session: { id: '', name: '', currentVersionId: 'v0', versions: [], messages: [] },
  projects: [],
  currentVersion: () => EMPTY_VERSION,
  setCurrentProject: () => {},
  setCurrentVersion: () => {},
  createProject: () => ({ id: '', name: '' }),
}))
