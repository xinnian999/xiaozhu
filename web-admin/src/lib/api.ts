// ============================================
// 管理后台 API 封装 —— 按后端 app/api/admin/ 的资源分组一一对应
// ============================================

import { http } from './http'

// ── 登录 / 当前管理员 ─────────────────────────────────────────
export type ApiUser = {
  id: string
  email: string
  nickname: string
  avatar: string
  created_at: string
}

export async function login(email: string, password: string): Promise<string> {
  const res = await http.post('/api/users/login', { email, password })
  return res.data.access_token as string
}

export async function getMe(): Promise<ApiUser> {
  const res = await http.get('/api/users/me')
  return res.data as ApiUser
}

/** 校验当前 token 是否属于管理员：调一个受 get_current_admin 保护的接口，非管理员会 403。 */
export async function checkIsAdmin(): Promise<void> {
  await http.get('/api/admin/settings')
}

// ── 用户管理 ──────────────────────────────────────────────────
export type AdminUser = {
  id: string
  email: string
  nickname: string
  avatar: string
  created_at: string
  is_admin: boolean
  tier: string
  daily_used: number
  daily_date: string | null
  tier_expires_at: string | null
}

export type UserUpdatePayload = Partial<
  Pick<AdminUser, 'nickname' | 'tier' | 'daily_used' | 'is_admin'>
>

export async function listUsers(params: { q?: string; offset?: number; limit?: number }) {
  const res = await http.get<AdminUser[]>('/api/admin/users', { params })
  return res.data
}

export async function countUsers(params: { q?: string }) {
  const res = await http.get<number>('/api/admin/users/count', { params })
  return res.data
}

export async function updateUser(id: string, body: UserUpdatePayload) {
  const res = await http.patch<AdminUser>(`/api/admin/users/${id}`, body)
  return res.data
}

export async function grantTierBatch(userIds: string[], tier: 'pro' | 'max') {
  const res = await http.post<AdminUser[]>('/api/admin/users/grant-tier', {
    user_ids: userIds,
    tier,
  })
  return res.data
}

// ── 订单（列表只读 + 手动审核） ────────────────────────────────
export type AdminOrder = {
  id: string
  user_id: string
  user_nickname: string | null
  tier: string
  amount: string
  status: string
  payment_method: string | null
  pay_note: string | null
  created_at: string
  paid_at: string | null
  reviewed_at: string | null
  reject_reason: string | null
}

export async function listOrders(params: { offset?: number; limit?: number; status?: string }) {
  const res = await http.get<AdminOrder[]>('/api/admin/orders', { params })
  return res.data
}

export async function countOrders(params?: { status?: string }) {
  const res = await http.get<number>('/api/admin/orders/count', { params })
  return res.data
}

/** 审核通过：核对到账后放行升档。 */
export async function approveOrder(id: string) {
  const res = await http.post<AdminOrder>(`/api/admin/orders/${id}/approve`)
  return res.data
}

/** 驳回订单（对不上时）。 */
export async function rejectOrder(id: string, reason?: string) {
  const res = await http.post<AdminOrder>(`/api/admin/orders/${id}/reject`, { reason })
  return res.data
}

// ── 会话（只读 + 删） ─────────────────────────────────────────
export type AdminSession = {
  id: string
  user_id: string
  title: string | null
  created_at: string
  updated_at: string
}

export async function listSessions(params: { offset?: number; limit?: number }) {
  const res = await http.get<AdminSession[]>('/api/admin/sessions', { params })
  return res.data
}

export async function countSessions() {
  const res = await http.get<number>('/api/admin/sessions/count')
  return res.data
}

export async function deleteSession(id: string) {
  await http.delete(`/api/admin/sessions/${id}`)
}

// ── 邮箱验证码（只读 + 删） ───────────────────────────────────
export type AdminEmailCode = {
  email: string
  code: string
  attempts: number
  expires_at: string
  sent_at: string
}

export async function listEmailCodes(params: { offset?: number; limit?: number }) {
  const res = await http.get<AdminEmailCode[]>('/api/admin/email-codes', { params })
  return res.data
}

export async function countEmailCodes() {
  const res = await http.get<number>('/api/admin/email-codes/count')
  return res.data
}

export async function deleteEmailCode(email: string) {
  await http.delete(`/api/admin/email-codes/${encodeURIComponent(email)}`)
}

// ── 应用配置 ──────────────────────────────────────────────────
export type AdminSetting = {
  key: string
  value: string
  category: string
  is_secret: boolean
  description: string
}

export async function listSettings() {
  const res = await http.get<AdminSetting[]>('/api/admin/settings')
  return res.data
}

export async function updateSetting(key: string, value: string) {
  const res = await http.patch<AdminSetting>(`/api/admin/settings/${encodeURIComponent(key)}`, { value })
  return res.data
}

// ── LLM 模型 ──────────────────────────────────────────────────
export type AdminModel = {
  id: string
  name: string
  base_url: string | null
  api_key: string
  logo: string
  vision: boolean
  cost: number
  enabled: boolean
  sort_order: number
}

export type ModelCreatePayload = {
  id: string
  name: string
  base_url?: string | null
  api_key?: string
  logo?: string
  vision?: boolean
  cost?: number
  enabled?: boolean
  sort_order?: number
}

export type ModelUpdatePayload = Partial<Omit<ModelCreatePayload, 'id'>>

/** 导出/导入用的单条模型配置（含明文 api_key）。 */
export type ModelExportItem = ModelCreatePayload & {
  id: string
  name: string
}

export type ModelExportBundle = {
  version: number
  exported_at: string
  models: ModelExportItem[]
}

export type ModelImportResult = {
  created: number
  updated: number
  total: number
}

export type ModelTestResult = {
  ok: boolean
  message: string
  latency_ms: number | null
}

export async function listModels() {
  const res = await http.get<AdminModel[]>('/api/admin/models')
  return res.data
}

export async function exportModels() {
  const res = await http.get<ModelExportBundle>('/api/admin/models/export')
  return res.data
}

export async function importModels(models: ModelExportItem[]) {
  const res = await http.post<ModelImportResult>('/api/admin/models/import', { models })
  return res.data
}

export async function testModel(id: string) {
  const res = await http.post<ModelTestResult>(`/api/admin/models/${encodeURIComponent(id)}/test`)
  return res.data
}

export async function createModel(body: ModelCreatePayload) {
  const res = await http.post<AdminModel>('/api/admin/models', body)
  return res.data
}

export async function updateModel(id: string, body: ModelUpdatePayload) {
  const res = await http.patch<AdminModel>(`/api/admin/models/${id}`, body)
  return res.data
}

export async function deleteModel(id: string) {
  await http.delete(`/api/admin/models/${id}`)
}

export async function setModelsEnabled(ids: string[], enabled: boolean) {
  const res = await http.post<AdminModel[]>('/api/admin/models/set-enabled', {
    model_ids: ids,
    enabled,
  })
  return res.data
}
