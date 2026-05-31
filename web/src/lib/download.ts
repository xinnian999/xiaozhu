import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import type { FileMap } from '@/types/project'

// ============================================
// 下载工具：把当前项目的源码打包成 zip 触发浏览器下载
// ============================================

/**
 * 把一组文件（path -> content）打包成 zip 并触发下载。
 * @param files       文件映射，键是相对路径（如 src/App.tsx），值是文件内容
 * @param projectName 项目名，用来生成 zip 文件名
 */
export async function downloadSourceAsZip(files: FileMap, projectName: string) {
  const zip = new JSZip()
  // JSZip 支持用带 "/" 的路径直接建文件，会自动还原出目录层级
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  // 文件名只清掉文件系统非法字符（保留中文等），整体为空时兜底成 project
  const safe =
    projectName
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-') || 'project'
  saveAs(blob, `${safe}.zip`)
}
