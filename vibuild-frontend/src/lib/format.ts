// ============================================
// 通用格式化工具
// ============================================

/** 把秒数转成"3h 44m"形式 */
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

/** 格式化时间为 11:13 AM 风格 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  let h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m.toString().padStart(2, '0')} ${ampm}`
}

/** 类似 git 短哈希的伪 ID（仅展示用） */
export function shortHash(id: string): string {
  // 简单 hash：把字符串转成 6 位十六进制
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(6, '0').slice(0, 6)
}
