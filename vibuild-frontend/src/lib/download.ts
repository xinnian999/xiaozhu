import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import type { Version } from '@/types/project'

// ============================================
// 下载工具：把某个版本的文件打包成 zip 触发下载
// ============================================

export async function downloadVersionAsZip(version: Version, projectName: string) {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(version.files)) {
    zip.file(path, content)
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  // 文件名形如：cool-personal-blog-2-v3.zip
  const safe = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  saveAs(blob, `${safe}-${version.id}.zip`)
}
