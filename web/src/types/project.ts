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
  /** 消息种类：'text' 为正常对话气泡，'tool' 为工具调用进度卡。
   *  缺省视为 'text'，保持向后兼容。 */
  kind?: 'text' | 'tool'
  /** kind === 'tool' 时使用：工具名（如 write_file / read_file / list_files） */
  toolName?: string
  /** kind === 'tool' 时使用：工具参数的摘要（如 { path: 'src/App.tsx' }） */
  toolArgs?: Record<string, unknown>
  /** 该消息产出的版本（仅 assistant 消息有） */
  producedVersionId?: string
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