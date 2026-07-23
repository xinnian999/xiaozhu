// ============================================
// 项目数据模型（与后端 / SSE 协议对齐）
// ============================================
// 这里只放纯类型，不依赖任何 mock 数据，方便接后端时直接复用：
//  - files：file_write 累积结果
//  - branchId / parentVersionId：构成版本树（父指针 + 分支染色）

/** 文件路径 → 内容 */
export type FileMap = Record<string, string>

export type Version = {
  id: string
  label: string
  createdAt: number
  files: FileMap
  /** 与上一版的 diff 概览（后端对比父版本算出，前端只展示） */
  diff: { added: number; removed: number }
  /** 所属对话分支（主线为 'main'） */
  branchId: string
  /** 父版本 id（构成版本树；根版本为 undefined） */
  parentVersionId?: string
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 消息种类：'text' 正常对话气泡，'reasoning' 可折叠思考过程，
   *  'tool' 工具调用进度卡，'version' 版本卡（带回滚按钮），
   *  'error' 错误卡（AI 报错时在对话流里就地展示，text 存错误说明）。
   *  缺省视为 'text'，保持向后兼容。 */
  kind?: 'text' | 'reasoning' | 'tool' | 'version' | 'error'
  /** kind === 'reasoning'：厂商返回的推理 token 数（没有则省略） */
  reasoningTokens?: number
  /** kind === 'reasoning'：true 表示没有正文，text 是系统生成的兜底说明 */
  reasoningFallback?: boolean
  /** kind === 'reasoning'：正文超过服务端上限时为 true */
  reasoningTruncated?: boolean
  /** kind === 'reasoning'：一次模型调用内稳定的流 id，用于增量帧更新同一张卡 */
  reasoningStreamId?: string
  /** kind === 'reasoning'：true 表示推理正文仍在实时追加 */
  reasoningStreaming?: boolean
  /** kind === 'tool' 时使用：工具名（如 write_file / read_file / list_files） */
  toolName?: string
  /** kind === 'tool' 时使用：工具参数的摘要（如 { path: 'src/App.tsx' }） */
  toolArgs?: Record<string, unknown>
  /** kind === 'tool' 时使用：后端的 tool_call_id，用于把流式到达的 toolResult 关联回本卡 */
  toolCallId?: string
  /** kind === 'tool' 时使用：工具执行结果文本（写入回执 / 文件内容 / 报错等，已截断） */
  toolResult?: string
  /** kind === 'version' 时使用：版本主键 id（回滚按钮调 restore 用） */
  versionId?: number
  /** kind === 'version' 时使用：版本序号（卡片显示 vN） */
  versionSeq?: number
  /** 该消息产出的版本（仅 assistant 消息有） */
  producedVersionId?: string
  /** 用户随消息发送的图片（data URL 列表），用于在气泡里展示缩略图。仅 user 消息有 */
  images?: string[]
  /** 此条消息发送时刻 */
  createdAt: number
  /** 所属对话分支，与 Version.branchId 对齐（主线为 'main'） */
  branchId: string
}

export type Session = {
  id: string
  name: string
  /** 项目一句话描述（卡片 / 列表副标题） */
  description?: string
  messages: Message[]
  versions: Version[]
  currentVersionId: string
  /** 项目创建时间（最早的版本时间） */
  createdAt?: number
  /** 最后一次活动（用于排序） */
  updatedAt?: number
}
