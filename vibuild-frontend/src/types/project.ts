// ============================================
// 项目数据模型（与后端 / SSE 协议对齐）
// ============================================
// 这里只放纯类型，不依赖任何 mock 数据，方便接后端时直接复用：
//  - files：file_write 累积结果
//  - branchId / parentVersionId：构成版本树（父指针 + 分支染色）
//  - authorRole：版本由 AI 产出还是用户手动 checkpoint

/** 文件路径 → 内容 */
export type FileMap = Record<string, string>

/** 谁创建了这个版本 */
export type AuthorRole = 'assistant' | 'user'

export type Version = {
  id: string
  label: string
  /** 该版本被创建时的描述（用户那条消息的摘要） */
  summary: string
  createdAt: number
  files: FileMap
  /** 与上一版的 diff 概览 */
  diff: { added: number; removed: number }
  /** 所属对话分支（默认 main 为主线） */
  branchId?: string
  /** 父版本 id（构成版本树；根版本为 undefined） */
  parentVersionId?: string
  /** 创建者：AI 产出（默认）或 用户手动 checkpoint */
  authorRole?: AuthorRole
}

export type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 该消息产出的版本（仅 assistant 消息有） */
  producedVersionId?: string
  /** 此条消息发送时刻 */
  ts: number
  /** 所属对话分支，与 Version.branchId 对齐 */
  branchId?: string
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