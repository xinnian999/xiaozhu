// ============================================
// 头像种子工具
// ============================================
// 单独成文件（不放进 Avatar 组件里），是为了满足 eslint 的 react-refresh 规则：
// 组件文件只导出组件，工具函数另置。

/** 随机生成一个新的头像种子（改资料「换一个」时用）。
 *  用 crypto 生成 6 字节并转十六进制，和后端 secrets.token_hex(6) 同格式。 */
export function genAvatarSeed(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
