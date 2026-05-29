import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import type { FileMap } from '@/types/project'

// ============================================
// WebContainer 单例封装
// ============================================
// - 整页只能 boot 一次，再次 boot 会抛错，所以用模块级单例
// - 暴露 boot/install/dev/syncFiles 四个高层动作
// - 通过事件回调把状态变化报告给上层，避免循环依赖 store

let containerPromise: Promise<WebContainer> | null = null
let devServerStarted = false
let lastFiles: FileMap | null = null  // 上次 mount 的文件快照，用于增量 diff

/** 启动（首次调用真正 boot，之后返回同一个实例） */
export function getContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    containerPromise = WebContainer.boot()
  }
  return containerPromise
}

/** 把扁平 FileMap 转成 WebContainer 需要的嵌套树结构 */
function toFileTree(files: FileMap): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    let cursor: FileSystemTree = tree
    parts.forEach((seg, i) => {
      const isFile = i === parts.length - 1
      if (isFile) {
        cursor[seg] = { file: { contents } }
      } else {
        // 目录节点
        if (!cursor[seg] || !('directory' in cursor[seg])) {
          cursor[seg] = { directory: {} }
        }
        cursor = (cursor[seg] as { directory: FileSystemTree }).directory
      }
    })
  }
  return tree
}

/** 全量 mount（首次启动 + npm install + dev server） */
export async function bootAndRun(
  files: FileMap,
  hooks: {
    onStatus: (s: 'booting' | 'mounting' | 'installing' | 'starting' | 'ready' | 'error') => void
    onUrl: (url: string) => void
    onLog: (line: string) => void
    onError: (msg: string) => void
  },
): Promise<void> {
  try {
    hooks.onStatus('booting')
    const wc = await getContainer()

    hooks.onStatus('mounting')
    await wc.mount(toFileTree(files))
    lastFiles = { ...files }

    // 监听后续 server-ready 事件（dev 启动后 vite 端口 ready 时触发）
    wc.on('server-ready', (_port, url) => {
      hooks.onUrl(url)
      hooks.onStatus('ready')
    })

    // npm install
    hooks.onStatus('installing')
    const install = await wc.spawn('npm', ['install'])
    install.output.pipeTo(
      new WritableStream({
        write(chunk) {
          // 把多行日志压缩成最后一行展示
          const line = chunk.toString().split('\n').filter(Boolean).pop()
          if (line) hooks.onLog(line.slice(0, 80))
        },
      }),
    )
    const installCode = await install.exit
    if (installCode !== 0) {
      throw new Error(`npm install 失败 (exit ${installCode})`)
    }

    // npm run dev
    hooks.onStatus('starting')
    const dev = await wc.spawn('npm', ['run', 'dev'])
    devServerStarted = true
    dev.output.pipeTo(
      new WritableStream({
        write(chunk) {
          const line = chunk.toString().split('\n').filter(Boolean).pop()
          if (line) hooks.onLog(line.slice(0, 80))
        },
      }),
    )
    // 不 await dev.exit —— 它是常驻进程
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    hooks.onError(msg)
    hooks.onStatus('error')
  }
}

/** 计算 diff，将变化文件增量写入容器；不重启 dev server，依赖 vite HMR */
export async function syncFiles(
  files: FileMap,
  hooks: { onLog: (line: string) => void },
): Promise<{ added: number; modified: number; removed: number }> {
  const wc = await getContainer()
  const prev = lastFiles ?? {}

  let added = 0
  let modified = 0
  let removed = 0

  // 新增 + 修改
  for (const [path, content] of Object.entries(files)) {
    if (!(path in prev)) {
      added++
    } else if (prev[path] !== content) {
      modified++
    } else {
      continue
    }
    // 父目录可能尚未存在，先 mkdir -p
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) {
      try {
        await wc.fs.mkdir(dir, { recursive: true })
      } catch {
        // 已存在则忽略
      }
    }
    await wc.fs.writeFile(path, content)
  }

  // 删除
  for (const path of Object.keys(prev)) {
    if (!(path in files)) {
      try {
        await wc.fs.rm(path)
        removed++
      } catch {
        // 文件可能已不存在
      }
    }
  }

  lastFiles = { ...files }
  hooks.onLog(`synced +${added} ~${modified} -${removed}`)

  return { added, modified, removed }
}

/** 当前是否已 boot（用于决定走全量还是增量） */
export function isBooted(): boolean {
  return containerPromise !== null
}

/** dev server 是否已起来（用于决定是否要走完整 install/dev 流程） */
export function isDevRunning(): boolean {
  return devServerStarted
}
