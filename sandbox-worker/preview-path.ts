/** 预览网关在真实 iframe URL 中使用的 capability 路径前缀。 */
export const PREVIEW_CAPABILITY_PATH_PATTERN_SOURCE =
  '^/api/sandbox-preview/[^/]+'

/**
 * 把预览网关地址转换成生成应用自己的逻辑路由。
 *
 * 实际 iframe 仍保留 capability 做鉴权；这个结果只用于小筑的模拟地址栏，
 * 避免安全凭证遮住 HashRouter 等应用路由。
 */
export function logicalPreviewPath(
  pathname: string,
  search = '',
  hash = '',
): string {
  const capabilityPrefix = new RegExp(PREVIEW_CAPABILITY_PATH_PATTERN_SOURCE)
  const strippedPath = pathname.replace(capabilityPrefix, '')
  const normalizedPath = strippedPath
    ? (strippedPath.startsWith('/') ? strippedPath : `/${strippedPath}`)
    : '/'
  return `${normalizedPath}${search}${hash}`
}
