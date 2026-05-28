// ============================================
// 文件树工具：扁平 files map → 树结构
// ============================================

export type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children?: TreeNode[]
}

/** 将 { "a/b/c.ts": "..." } 这种扁平 map 转成树结构 */
export function buildTree(files: Record<string, string>): TreeNode[] {
  const root: TreeNode = { name: '', path: '', isDir: true, children: [] }

  // 排序后插入，保证目录之间字母序稳定
  const paths = Object.keys(files).sort()

  for (const fullPath of paths) {
    const parts = fullPath.split('/')
    let cursor = root
    parts.forEach((part, idx) => {
      const isLast = idx === parts.length - 1
      const path = parts.slice(0, idx + 1).join('/')
      let child = cursor.children!.find((n) => n.name === part && n.isDir !== isLast)
      // children 中可能存在同名 dir 与 file 区分（虽然实际不会出现），用上面的判断同时兼容
      if (!child) {
        child = isLast
          ? { name: part, path, isDir: false }
          : { name: part, path, isDir: true, children: [] }
        cursor.children!.push(child)
      }
      if (!isLast) cursor = child
    })
  }

  // 同层排序：文件夹在前，文件在后，同类按字母
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => n.children && sort(n.children))
  }
  sort(root.children!)

  return root.children!
}

/** 后缀 → Monaco 语言 id */
export function detectLanguage(path: string): string {
  // 特殊文件名优先匹配
  const base = path.split('/').pop()!
  if (base === '.gitignore' || base === '.env' || base.startsWith('.env.')) return 'shell'
  if (base === 'Dockerfile') return 'dockerfile'
  if (base === 'README' || base === 'LICENSE') return 'plaintext'

  const ext = base.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json',
    md: 'markdown', mdx: 'markdown',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml',
    yaml: 'yaml', yml: 'yaml',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql',
    toml: 'ini', ini: 'ini',
  }
  return map[ext] ?? 'plaintext'
}
