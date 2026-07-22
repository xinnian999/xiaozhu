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
  user_email: string | null
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
  user_nickname: string | null
  user_email: string | null
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

// ── 预览 boot 失败监控（只读） ────────────────────────────────
// WebContainer 运行环境从境外 boot，国内偶发失败。C 端前端上报到 boot_failures 表，
// 这里拉出来做监控。
export type AdminBootFailure = {
  id: number
  session_id: string | null
  user_id: string | null
  // 由后端 join users 填充：所属用户昵称 / 邮箱（裸 id 无意义，改展示这两个）。
  user_nickname: string | null
  user_email: string | null
  stage: string
  kind: string
  message: string
  cross_origin_isolated: boolean | null
  elapsed_ms: number | null
  cold: boolean | null
  user_agent: string | null
  created_at: string
}

// boot 耗时统计：成功样本的耗时（总体 + 冷/热分组）、失败计数、成功耗时分布直方图。
export type BootStatGroup = {
  count: number
  avg_ms: number | null
  min_ms: number | null
  max_ms: number | null
}
export type BootStats = {
  success: BootStatGroup
  success_cold: BootStatGroup
  success_hot: BootStatGroup
  failed: Record<string, number> // { timeout: n, error: m }
  buckets: { label: string; count: number }[] // 成功耗时分档直方图
}

export async function listBootFailures(params: { offset?: number; limit?: number; kind?: string }) {
  const res = await http.get<AdminBootFailure[]>('/api/admin/boot-failures', { params })
  return res.data
}

export async function countBootFailures(params?: { kind?: string }) {
  const res = await http.get<number>('/api/admin/boot-failures/count', { params })
  return res.data
}

export async function recentBootFailures(hours = 24) {
  const res = await http.get<number>('/api/admin/boot-failures/recent-count', {
    params: { hours },
  })
  return res.data
}

/** boot 耗时统计（成功耗时 + 冷/热分组 + 失败计数 + 分布直方图）。 */
export async function getBootStats() {
  const res = await http.get<BootStats>('/api/admin/boot-failures/boot-stats')
  return res.data
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
  provider: string
  base_url: string | null
  api_key: string
  logo: string
  vision: boolean
  cost: number
  enabled: boolean
  sort_order: number
}

/** 后端预制的模型厂商目录；Logo 与默认端点都由厂商配置统一维护。 */
export type ModelProvider = {
  id: string
  label: string
  logo: string
  adapter: string
  default_base_url: string | null
  description: string
}

export type ModelCreatePayload = {
  id: string
  provider: string
  base_url?: string | null
  api_key?: string
  vision?: boolean
  cost?: number
  enabled?: boolean
  sort_order?: number
}

export type ModelUpdatePayload = Partial<Omit<ModelCreatePayload, 'id'>>

/**
 * 导出/导入用的单条模型配置（含明文 api_key）。
 * provider 可选是为了继续兼容尚未包含厂商字段的历史导出包；logo 仅作旧格式兼容。
 */
export type ModelExportItem = Omit<ModelCreatePayload, 'provider'> & {
  provider?: string
  logo?: string
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

export type ModelTestCapability =
  | 'connectivity'
  | 'vision'
  | 'thinking'
  | 'tools'

export type ModelCapabilityTestDetail = {
  key: 'thinking' | 'reasoning_content' | 'disable_thinking'
  label: string
  status: 'passed' | 'unsupported' | 'failed'
  message: string
}

export type ModelCapabilityTestResult = {
  capability: ModelTestCapability
  status: 'passed' | 'unsupported' | 'failed'
  message: string
  latency_ms: number | null
  details: ModelCapabilityTestDetail[]
}

/**
 * 后端单次模型调用最多等待 30 秒；“关闭思考”会先开后关、连续调用两次。
 * 这里给网络与序列化留少量余量，避免全局 10 秒超时把慢推理误报为能力失败。
 */
export function modelCapabilityTestTimeout(capability: ModelTestCapability) {
  return capability === 'thinking' ? 65_000 : 35_000
}

export async function listModels() {
  const res = await http.get<AdminModel[]>('/api/admin/models')
  return res.data
}

export async function listModelProviders() {
  const res = await http.get<ModelProvider[]>('/api/admin/models/providers')
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

export async function testModelCapability(id: string, capability: ModelTestCapability) {
  const timeout = modelCapabilityTestTimeout(capability)
  const res = await http.post<ModelCapabilityTestResult>(
    `/api/admin/models/operations/model/test/${capability}`,
    undefined,
    { params: { model_id: id }, timeout },
  )
  return res.data
}

export async function createModel(body: ModelCreatePayload) {
  const res = await http.post<AdminModel>('/api/admin/models', body)
  return res.data
}

export async function updateModel(id: string, body: ModelUpdatePayload) {
  const res = await http.patch<AdminModel>('/api/admin/models/operations/model', body, {
    params: { model_id: id },
  })
  return res.data
}

export async function deleteModel(id: string) {
  await http.delete('/api/admin/models/operations/model', { params: { model_id: id } })
}

export async function setModelsEnabled(ids: string[], enabled: boolean) {
  const res = await http.post<AdminModel[]>('/api/admin/models/set-enabled', {
    model_ids: ids,
    enabled,
  })
  return res.data
}
