import { create } from 'zustand'
import type { Message } from '@/types/project'
import {
  createSession,
  listSessions,
  listSessionFiles,
  listSessionMessages,
  listModels,
  getBilling,
  saveVersion,
  restoreVersion,
  listVersions,
  renameSession as apiRenameSession,
  deleteSession as apiDeleteSession,
  type ApiSession,
  type ApiMessage,
  type ApiModel,
  type ApiBilling,
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
  // ask_user 触发 interrupt() 暂停本轮、SSE 流已正常结束、但用户还没提交回答的中间态。
  // 和 isStreaming 是两个独立的锁：迁移到 interrupt() 后这段等待期间没有任何请求挂着，
  // 但发送框依然要保持禁用，直到 resume 流真正推来 done/error。
  awaitingAnswer: boolean
  // 当前 session 的文件快照：path -> content（已保存/已生成的内容）
  files: Record<string, string>
  // 编辑器里暂存但还没保存的改动：path -> 新内容。
  // 只放和 files 不一致的文件；为空表示没有未保存改动。
  // 编辑只写这里，不动 files，所以预览不会实时变；点「保存」才落库产生新版本。
  drafts: Record<string, string>
  // 文件快照版本号，每次 files 变更 +1
  versionId: number
}

type SessionState = {
  sessions: ChatSession[]
  activeId: string | null
  loading: boolean

  // 可选模型清单（从后端 /api/models 拉，全局共享，不分会话）+ 当前选中的模型 id。
  // 模型选择是「每条消息可变」的：选了哪个，下次发消息就用哪个，不绑定到会话。
  models: ApiModel[]
  selectedModel: string | null
  /** 拉取模型清单；首个模型作为默认选中 */
  loadModels: () => Promise<void>
  /** 切换当前选中的模型 */
  setSelectedModel: (id: string) => void

  // 当前用户的额度状态（档位 + 今日剩余点数），全局共享。null = 还没拉到。
  billing: ApiBilling | null
  /** 拉取/刷新额度状态。每轮对话结束后调一次，让「今日剩余」实时跟着扣减。 */
  loadBilling: () => Promise<void>

  init: () => Promise<void>
  createNew: (title?: string) => Promise<ChatSession>
  /** 重命名会话：PATCH 后端，成功后更新本地列表里的 title */
  renameSession: (id: string, title: string) => Promise<void>
  /** 删除会话：DELETE 后端，成功后从列表移除；删的若是当前会话则回到空态首屏 */
  deleteSession: (id: string) => Promise<void>
  switchTo: (id: string) => Promise<void>
  /** 回到"无激活会话"的空态首屏，不真正创建会话 */
  goToEmpty: () => void
  appendMessage: (msg: Message) => void
  /** 重试前的截断：移除「最新一轮用户消息」之后的所有消息（旧回复 / 工具卡 / 版本卡），
   *  让对话看起来像把这条消息重新发了一遍。版本快照在后端保留，可在「版本历史」回滚。 */
  truncateAfterLastUserMessage: () => void
  /** 工具执行完，把结果填到对应工具卡（按 toolCallId 匹配当前会话里那条 tool 消息） */
  setToolResult: (toolCallId: string, result: string) => void
  /** 工具卡「有则更新、无则新建」：流式阶段先用 {path} 提前建卡，工具调用整段生成完后
   *  再用完整参数（含 write_file 的 content）按 toolCallId 补全同一张卡，展开即可看到全部参数。
   *  无 path、没提前发的工具（list_files / check_build）则由完整参数这一发直接新建。 */
  upsertToolCall: (toolCallId: string, name: string, args: Record<string, unknown>) => void
  setStreamingText: (text: string) => void
  /** 开始一轮流式：立刻把 isStreaming 置 true（不等首个 token），让发送按钮即时变成"停止" */
  beginStreaming: () => void
  /** 把当前累积的 streamingText 固化成一条消息并清空，但不结束流式（工具调用前的中途冲刷用） */
  commitStreaming: () => void
  /** 结束一轮流式：冲刷剩余文本并把 isStreaming 置 false（正常结束 / 出错 / 用户中断都走这里） */
  endStreaming: () => void
  /** ask_user 触发 interrupt() 暂停本轮：进入"等待回答"态，继续禁用发送框 */
  beginAwaitingAnswer: () => void
  /** 提交回答、发起 resume 流之前调用：退出"等待回答"态（随即由 beginStreaming 接管禁用状态） */
  endAwaitingAnswer: () => void

  /** SSE 收到 file_write：增量写入当前会话的 files */
  applyFileWrite: (path: string, content: string) => void
  /** SSE 收到 file_delete：从当前会话的 files 移除 */
  applyFileDelete: (path: string) => void
  /** 用一组文件整体替换当前会话的 files（回滚到某版本时用） */
  replaceFiles: (files: Record<string, string>) => void

  /** 编辑器改动：写入草稿。内容若改回和已保存一致，则把该文件移出草稿 */
  setDraft: (path: string, content: string) => void
  /** 丢弃当前会话所有未保存的草稿 */
  discardDrafts: () => void
  /** 保存草稿：提交后端 upsert + 快照新版本 → 替换 files、清空草稿、追加版本卡 */
  saveDrafts: () => Promise<void>
  /** 回滚到指定版本：覆盖 files 并 append 新版本，同时追加一张版本卡 */
  rollbackToVersion: (versionId: number) => Promise<void>

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
    awaitingAnswer: false,
    files: {},
    drafts: {},
    versionId: 0,
  }
}

/** 把后端的 ApiMessage 转成前端 Message 类型。
 *  branchId 现阶段统一 'main'，后端没有这个概念但前端类型要求有。
 *  kind='tool' 还原成工具卡；kind='version' 还原成版本卡（从 tool_args 取 version_id/seq）。 */
function fromApiMessage(m: ApiMessage): Message {
  const base = {
    id: `srv-${m.id}`,
    role: m.role,
    text: m.text,
    createdAt: new Date(m.created_at).getTime(),
    branchId: 'main',
    // 带图的用户消息：把图片 data URL 还原出来，刷新后气泡里仍能看到缩略图
    ...(m.images && m.images.length ? { images: m.images } : {}),
  } as const

  if (m.kind === 'tool') {
    return {
      ...base,
      kind: 'tool',
      toolName: m.tool_name ?? undefined,
      toolArgs: m.tool_args ?? undefined,
      // 工具消息的 text 存的是「工具执行结果」，刷新后还原到 toolResult 供卡片展示
      toolResult: m.text || undefined,
    }
  }
  if (m.kind === 'version') {
    const args = m.tool_args ?? {}
    return {
      ...base,
      kind: 'version',
      versionId: typeof args.version_id === 'number' ? args.version_id : undefined,
      versionSeq: typeof args.seq === 'number' ? args.seq : undefined,
    }
  }
  return base
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

/** 构造一张「版本卡」消息（kind='version'）。AI 流 / 手动保存 / 回滚 三处共用，
 *  让对话时间线在每次产生新版本时插入一张带回滚按钮的卡片。 */
export function makeVersionCard(versionId: number, seq: number): Message {
  return makeMessage('assistant', '', { kind: 'version', versionId, versionSeq: seq })
}

/** 构造一张「错误卡」消息（kind='error'）。AI 报错（如模型未配 api_key、超长截断、超轮）时，
 *  在对话流里就地插一张红色提示卡，比一闪而过的 toast 更醒目、可回看。
 *  纯前端临时消息，不入库 —— 刷新后消失（错误本就是一次性的，不必持久化）。 */
export function makeErrorCard(message: string): Message {
  return makeMessage('assistant', message, { kind: 'error' })
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

  models: [],
  selectedModel: null,

  loadModels: async () => {
    try {
      const models = await listModels()
      set((s) => ({
        models,
        // 还没选过模型时，默认选第一个；已经选过就保持用户的选择
        selectedModel: s.selectedModel ?? models[0]?.id ?? null,
      }))
    } catch (e) {
      console.error('加载模型清单失败', e)
    }
  },

  setSelectedModel: (id) => set({ selectedModel: id }),

  billing: null,

  loadBilling: async () => {
    try {
      const billing = await getBilling()
      set({ billing })
    } catch (e) {
      // 额度拉取失败不该影响主流程（如未登录）—— 静默，UI 会退回不显示额度
      console.error('加载额度状态失败', e)
    }
  },

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

  renameSession: async (id, title) => {
    // 后端做空标题校验并回写 updated_at；这里拿返回的 title 落到本地列表
    const api = await apiRenameSession(id, title)
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, title: api.title ?? sess.title } : sess,
      ),
    }))
  },

  deleteSession: async (id) => {
    // 先请求后端删除（连带级联清理子表）；失败会被 axios 拦截器统一 toast，这里不动本地
    await apiDeleteSession(id)
    // 删的若是当前激活会话，先回到空态首屏（清激活态 + URL），再把它从列表移除
    if (get().activeId === id) get().goToEmpty()
    set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }))
    // 顺手清掉该会话的 currentVersion 缓存，避免内存里残留无主对象
    versionCache.delete(id)
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

  truncateAfterLastUserMessage: () => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        // 从后往前找最后一条用户消息，截断到它（含）为止：它之后的旧回复 / 工具卡 /
        // 版本卡都从对话里移除，看起来就像把这条消息重新发了出去。
        let lastUserIdx = -1
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          if (sess.messages[i].role === 'user') {
            lastUserIdx = i
            break
          }
        }
        if (lastUserIdx === -1) return sess
        return { ...sess, messages: sess.messages.slice(0, lastUserIdx + 1) }
      }),
    }))
  },

  setToolResult: (toolCallId, result) => {
    const id = get().activeId
    if (!id) return
    // 找到当前会话里 toolCallId 匹配的那条工具卡，把结果填上
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        return {
          ...sess,
          messages: sess.messages.map((m) =>
            m.kind === 'tool' && m.toolCallId === toolCallId ? { ...m, toolResult: result } : m,
          ),
        }
      }),
    }))
  },

  upsertToolCall: (toolCallId, name, args) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        const exists = sess.messages.some(
          (m) => m.kind === 'tool' && m.toolCallId === toolCallId,
        )
        if (exists) {
          // 已有这张卡（流式阶段提前建的）→ 只更新工具名 / 参数，保留它的位置和已填的结果
          return {
            ...sess,
            messages: sess.messages.map((m) =>
              m.kind === 'tool' && m.toolCallId === toolCallId
                ? { ...m, toolName: name, toolArgs: args }
                : m,
            ),
          }
        }
        // 没有 → 新建一张追加到末尾
        return {
          ...sess,
          messages: [
            ...sess.messages,
            makeMessage('assistant', '', {
              kind: 'tool',
              toolName: name,
              toolArgs: args,
              toolCallId,
            }),
          ],
        }
      }),
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

  beginAwaitingAnswer: () => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, awaitingAnswer: true } : sess,
      ),
    }))
  },

  endAwaitingAnswer: () => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, awaitingAnswer: false } : sess,
      ),
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

  setDraft: (path, content) => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) => {
        if (sess.id !== id) return sess
        const committed = sess.files[path] ?? ''
        const drafts = { ...sess.drafts }
        if (content === committed) {
          // 改回和已保存内容一致 → 不再算"脏"，移出草稿（这样保存按钮能正确消失）
          delete drafts[path]
        } else {
          drafts[path] = content
        }
        return { ...sess, drafts }
      }),
    }))
  },

  discardDrafts: () => {
    const id = get().activeId
    if (!id) return
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, drafts: {} } : sess,
      ),
    }))
  },

  saveDrafts: async () => {
    const id = get().activeId
    if (!id) return
    const sess = get().sessions.find((s) => s.id === id)
    if (!sess) return
    const drafts = sess.drafts
    const count = Object.keys(drafts).length
    if (count === 0) return
    // 提交后端：upsert 改动文件 + 快照新版本，换回保存后的全部文件
    const files = await saveVersion(id, drafts, `手动编辑 ${count} 个文件`)
    get().replaceFiles(files) // 替换已保存文件 → PreviewPane 同步到新版本
    get().discardDrafts() // 清空草稿，按钮自动消失
    // 取最新版本（seq 最大 = 刚建的那个）追加一张版本卡到对话流
    const vers = await listVersions(id)
    if (vers[0]) get().appendMessage(makeVersionCard(vers[0].id, vers[0].seq))
  },

  rollbackToVersion: async (versionId) => {
    const id = get().activeId
    if (!id) return
    // 后端用该版本快照覆盖当前文件并 append 一个新版本，返回回滚后的全部文件
    const files = await restoreVersion(id, versionId)
    get().replaceFiles(files)
    // 回滚也产生新版本，同样追加一张版本卡
    const vers = await listVersions(id)
    if (vers[0]) get().appendMessage(makeVersionCard(vers[0].id, vers[0].seq))
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
