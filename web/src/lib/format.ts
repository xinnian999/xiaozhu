// ============================================
// 通用格式化工具
// ============================================

/** 把毫秒时长格式化成适合生成记录展示的中文分秒。 */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`
}

/** 类似 git 短哈希的伪 ID（仅展示用） */
export function shortHash(id: string): string {
  // 简单 hash：把字符串转成 6 位十六进制
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(6, '0').slice(0, 6)
}
